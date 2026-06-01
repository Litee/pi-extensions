/**
 * Pure router that bridges pi socket clients ↔ Firefox add-on via injected deps.
 *
 * All I/O is provided by the caller (daemon.ts) through the DaemonCoreDeps
 * interface. No direct socket/process references here — fully unit-testable.
 *
 * Protocols:
 *  Unix socket (pi↔daemon): { id, op, params? } ↔ { id, ok, result|error }
 *  NM (addon↔daemon):       { correlationId, op, params? } ↔ { correlationId, ok, result|error }
 */

import type { DaemonLogger } from "./daemon-logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoggerLike {
	info(msg: string, data?: unknown): void;
	warn(msg: string, data?: unknown): void;
	error(msg: string, data?: unknown): void;
}

export interface DaemonCoreDeps {
	/** Write a message to the Firefox add-on over NM stdout. null = not connected. */
	addonWriter: ((msg: unknown) => void) | null;
	/** Write a response frame to a specific pi socket client. */
	socketWriter: (socketId: string, msg: unknown) => void;
	/** Logger that goes to file only. */
	logger: LoggerLike | DaemonLogger;
	/** Current time in milliseconds. */
	now: () => number;
	/** Schedule a callback after `ms` ms. Returns a cancel function. */
	schedule: (ms: number, fn: () => void) => (() => void);
}

interface PendingRequest {
	socketId: string;
	requestId: string;
	deadline: number;
	cancel: () => void;
}

// Timeouts per operation
const DEADLINE_MS: Record<string, number> = {
	listTabs: 20_000,
	getTabContent: 60_000,
	ping: 20_000,
};

// ---------------------------------------------------------------------------
// DaemonCore
// ---------------------------------------------------------------------------

export class DaemonCore {
	private readonly _deps: DaemonCoreDeps;
	private readonly _startTime: number;
	private _addonConnected: boolean;
	private _addonLastSeen: number | null = null;
	/** correlationId → pending request info */
	private readonly _pending: Map<string, PendingRequest> = new Map();

	constructor(deps: DaemonCoreDeps) {
		this._deps = deps;
		this._startTime = deps.now();
		this._addonConnected = deps.addonWriter !== null;
	}

	/** Process a raw framed request from a pi socket client. */
	handleSocketRequest(socketId: string, raw: unknown): void {
		if (!raw || typeof raw !== "object") return;
		const req = raw as Record<string, unknown>;
		const requestId = req["id"] as string | undefined;
		const op = req["op"] as string | undefined;

		if (!requestId || !op) {
			this._deps.logger.warn("invalid socket request", { raw });
			return;
		}

		// Status is answered locally — no addon needed
		if (op === "status") {
			this._deps.socketWriter(socketId, {
				id: requestId,
				ok: true,
				result: {
					daemon: {
						pid: process.pid,
						uptimeSec: Math.round((this._deps.now() - this._startTime) / 1000),
						version: "0.1.0",
					},
					addon: {
						connected: this._addonConnected,
						lastSeenSec:
							this._addonLastSeen !== null
								? Math.round((this._deps.now() - this._addonLastSeen) / 1000)
								: null,
					},
				},
			});
			return;
		}

		// Require addon writer for all other ops
		if (!this._deps.addonWriter) {
			this._deps.socketWriter(socketId, {
				id: requestId,
				ok: false,
				error: {
					code: "ADDON_NOT_CONNECTED",
					message: "The Firefox pi-browser-control add-on is not connected.",
				},
			});
			return;
		}

		// Generate a correlation ID and register pending request
		const correlationId = `${requestId}-${Math.random().toString(36).slice(2)}`;
		const deadlineMs = DEADLINE_MS[op] ?? 20_000;

		const cancel = this._deps.schedule(deadlineMs, () => {
			const pending = this._pending.get(correlationId);
			if (!pending) return;
			this._pending.delete(correlationId);
			this._deps.socketWriter(socketId, {
				id: requestId,
				ok: false,
				error: {
					code: "ADDON_TIMEOUT",
					message: `The add-on did not respond within ${deadlineMs / 1000}s.`,
				},
			});
		});

		this._pending.set(correlationId, {
			socketId,
			requestId,
			deadline: this._deps.now() + deadlineMs,
			cancel,
		});

		// Forward to addon
		const outbound: Record<string, unknown> = { correlationId, op };
		const params = req["params"];
		if (params !== undefined) {
			outbound["params"] = params;
		}
		this._deps.addonWriter(outbound);
	}

	/** Process a raw framed reply from the Firefox add-on. */
	handleAddonReply(raw: unknown): void {
		if (!raw || typeof raw !== "object") return;
		const reply = raw as Record<string, unknown>;
		const correlationId = reply["correlationId"] as string | undefined;
		if (!correlationId) return;

		// Update addon last-seen time
		this._addonLastSeen = this._deps.now();
		this._addonConnected = true;

		const pending = this._pending.get(correlationId);
		if (!pending) return; // already timed out or socket closed

		this._pending.delete(correlationId);
		pending.cancel(); // cancel the timeout

		const { socketId, requestId } = pending;

		if (reply["ok"] === true) {
			this._deps.socketWriter(socketId, {
				id: requestId,
				ok: true,
				result: reply["result"],
			});
		} else {
			const error = reply["error"] as { code: string; message: string } | undefined;
			this._deps.socketWriter(socketId, {
				id: requestId,
				ok: false,
				error: error ?? { code: "INTERNAL", message: "Unknown add-on error" },
			});
		}
	}

	/** Clean up all pending requests from a closed socket. */
	onSocketClosed(socketId: string): void {
		for (const [correlationId, pending] of this._pending) {
			if (pending.socketId === socketId) {
				pending.cancel();
				this._pending.delete(correlationId);
			}
		}
	}
}
