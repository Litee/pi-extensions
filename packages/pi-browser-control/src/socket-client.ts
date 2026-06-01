/**
 * Socket client: single-shot connect → one framed request → one framed response → close.
 *
 * Connects to the daemon unix socket, sends a request, waits for the matching
 * response, then closes the connection. Each call creates a fresh connection.
 *
 * Error mapping:
 *   ENOENT / ECONNREFUSED  → SocketClientError code:"DAEMON_NOT_RUNNING"
 *   response timeout       → SocketClientError code:"DAEMON_TIMEOUT"
 *   server error reply     → SocketClientError with the server's error code
 */

import net from "node:net";

import { encode, Decoder } from "./socket-protocol.js";
import { sockPath } from "./socket-paths.js";

// ---------------------------------------------------------------------------
// SocketClientError
// ---------------------------------------------------------------------------

export class SocketClientError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.name = "SocketClientError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// SocketClientLike (for DI in tests / index.ts)
// ---------------------------------------------------------------------------

export interface SocketClientLike {
	listTabs: () => Promise<unknown>;
	getTabContent: (tabId: number, offset: number) => Promise<unknown>;
	status: () => Promise<unknown>;
	ping: () => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// SocketClient options
// ---------------------------------------------------------------------------

export interface SocketClientOptions {
	/** Override default timeout (ms). Applied per-call. */
	timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// SocketClient
// ---------------------------------------------------------------------------

export class SocketClient implements SocketClientLike {
	private readonly _sockPath: string;
	private readonly _opts: SocketClientOptions;

	constructor(sockPathOverride?: string, opts: SocketClientOptions = {}) {
		this._sockPath = sockPathOverride ?? sockPath();
		this._opts = opts;
	}

	async listTabs(): Promise<unknown> {
		return this._request({ op: "listTabs" }, this._opts.timeoutMs ?? 10_000);
	}

	async getTabContent(tabId: number, offset: number): Promise<unknown> {
		return this._request(
			{ op: "getTabContent", params: { tabId, offset } },
			this._opts.timeoutMs ?? 30_000,
		);
	}

	async status(): Promise<unknown> {
		return this._request({ op: "status" }, this._opts.timeoutMs ?? 10_000);
	}

	async ping(): Promise<unknown> {
		return this._request({ op: "ping" }, this._opts.timeoutMs ?? 10_000);
	}

	private _request(
		req: { op: string; params?: Record<string, unknown> },
		timeoutMs: number,
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = Math.random().toString(36).slice(2);
			const socket = net.createConnection(this._sockPath);
			let settled = false;

			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				socket.destroy();
				reject(
					new SocketClientError(
						`Daemon did not respond within ${timeoutMs}ms.`,
						"DAEMON_TIMEOUT",
					),
				);
			}, timeoutMs);

			function settle(): void {
				settled = true;
				clearTimeout(timer);
			}

			socket.on("error", (err: NodeJS.ErrnoException) => {
				if (settled) return;
				settle();
				if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
					reject(
						new SocketClientError(
							"The pi-browser-control daemon is not running.",
							"DAEMON_NOT_RUNNING",
						),
					);
				} else {
					reject(err);
				}
			});

			const decoder = new Decoder();

			socket.on("data", (chunk: Buffer) => {
				if (settled) return;
				for (const msg of decoder.push(chunk)) {
					const resp = msg as { id?: string; ok?: boolean; result?: unknown; error?: { code: string; message: string } };
					if (resp.id !== id) continue;

					settle();
					socket.end();

					if (resp.ok === true) {
						resolve(resp.result);
					} else {
						const e = resp.error;
						reject(
							new SocketClientError(
								e?.message ?? "Unknown error from daemon",
								e?.code ?? "INTERNAL",
							),
						);
					}
					break;
				}
			});

			socket.on("connect", () => {
				const frame: Record<string, unknown> = { id, ...req };
				socket.write(encode(frame));
			});
		});
	}
}
