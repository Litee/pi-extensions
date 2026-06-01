/**
 * pi-browser-control daemon entry point.
 *
 * Launched by Firefox via the native-messaging manifest. Bridges:
 *   Firefox add-on (stdin/stdout NM frames) ↔ pi socket clients (unix socket)
 *
 * CRITICAL: stdout is exclusively for native-messaging frames.
 *           NEVER write console.* or process.stderr here — use DaemonLogger.
 *
 * Erasable-syntax-only TypeScript — no enums, no parameter properties,
 * no namespaces. Runs directly under Node 24 TS stripping:
 *   node packages/pi-browser-control/src/daemon/daemon.ts
 */

import net from "node:net";
import fs from "node:fs";

import { encode as nmEncode, Decoder as NmDecoder } from "./nm-framing.ts";
import { encode as sockEncode, Decoder as SockDecoder } from "../socket-protocol.ts";
import { DaemonCore } from "./daemon-core.ts";
import { DaemonLogger } from "./daemon-logger.ts";
import { sockPath, logPath } from "../socket-paths.ts";

// ---------------------------------------------------------------------------
// Logger (file-only — never stdout/stderr)
// ---------------------------------------------------------------------------

const logger = new DaemonLogger(logPath());

// ---------------------------------------------------------------------------
// Socket map: socketId → net.Socket
// ---------------------------------------------------------------------------

const socketMap = new Map<string, net.Socket>();
let socketSeq = 0;

// ---------------------------------------------------------------------------
// DaemonCore setup
// ---------------------------------------------------------------------------

const core = new DaemonCore({
	addonWriter: (msg: unknown) => {
		const frame = nmEncode(msg);
		process.stdout.write(frame);
	},
	socketWriter: (socketId: string, msg: unknown) => {
		const sock = socketMap.get(socketId);
		if (!sock) return;
		try {
			sock.write(sockEncode(msg));
		} catch (err: unknown) {
			logger.warn("socketWriter write error", { socketId, err: String(err) });
		}
	},
	logger,
	now: () => Date.now(),
	schedule: (ms: number, fn: () => void) => {
		const t = setTimeout(fn, ms);
		return () => clearTimeout(t);
	},
});

// ---------------------------------------------------------------------------
// Unix socket server
// ---------------------------------------------------------------------------

const SOCK_PATH = sockPath();

// Remove stale socket file
try {
	fs.unlinkSync(SOCK_PATH);
} catch {
	// ignore ENOENT
}

const server = net.createServer((conn: net.Socket) => {
	const socketId = `s${++socketSeq}`;
	socketMap.set(socketId, conn);

	const decoder = new SockDecoder();

	conn.on("data", (chunk: Buffer) => {
		try {
			for (const msg of decoder.push(chunk)) {
				core.handleSocketRequest(socketId, msg);
			}
		} catch (err: unknown) {
			logger.error("socket decoder error", { socketId, err: String(err) });
		}
	});

	conn.on("close", () => {
		core.onSocketClosed(socketId);
		socketMap.delete(socketId);
	});

	conn.on("error", (err: Error) => {
		logger.warn("socket connection error", { socketId, err: err.message });
		core.onSocketClosed(socketId);
		socketMap.delete(socketId);
	});
});

server.listen(SOCK_PATH, () => {
	try {
		fs.chmodSync(SOCK_PATH, 0o600);
	} catch (err: unknown) {
		logger.warn("chmod socket failed", { err: String(err) });
	}
	logger.info("daemon started", { pid: process.pid, sock: SOCK_PATH });
});

server.on("error", (err: Error) => {
	logger.error("server error", { err: err.message });
});

// ---------------------------------------------------------------------------
// Stdin: native-messaging frames from Firefox add-on
// ---------------------------------------------------------------------------

const nmDecoder = new NmDecoder();

process.stdin.on("data", (chunk: Buffer) => {
	try {
		for (const msg of nmDecoder.push(chunk)) {
			core.handleAddonReply(msg);
		}
	} catch (err: unknown) {
		logger.error("NM stdin decoder error", { err: String(err) });
	}
});

process.stdin.on("end", () => {
	logger.info("stdin EOF — addon disconnected, shutting down");
	shutdown(0);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(code: number): void {
	server.close(() => {
		try {
			fs.unlinkSync(SOCK_PATH);
		} catch {
			// ignore
		}
		process.exit(code);
	});
}

process.on("SIGINT", () => {
	logger.info("SIGINT received");
	shutdown(0);
});

process.on("SIGTERM", () => {
	logger.info("SIGTERM received");
	shutdown(0);
});
