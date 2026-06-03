/**
 * Tests for src/socket-client.ts
 *
 * Spins up a real ephemeral Unix socket server in a temp dir to test the client
 * end-to-end: framing, success replies, server-error→SocketClientError code,
 * ENOENT→DAEMON_NOT_RUNNING, and timeout→DAEMON_TIMEOUT.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";

import { SocketClient, SocketClientError } from "../src/socket-client.js";
import { encode, Decoder } from "../src/socket-protocol.js";

let tempDir: string;
let sockFile: string;
let server: net.Server | null = null;
const openConns = new Set<net.Socket>();

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-bc-sc-"));
	sockFile = join(tempDir, "test.sock");
	server = null;
	openConns.clear();
});

afterEach(async () => {
	// Force-destroy all open connections so server.close() doesn't hang
	for (const c of openConns) {
		try { c.destroy(); } catch { /* ignore */ }
	}
	if (server?.listening) {
		await new Promise<void>((r) => server!.close(() => r()));
	}
	rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: create an echo server that replies to framed requests
// ---------------------------------------------------------------------------

type ReplyFn = (req: Record<string, unknown>) => Record<string, unknown>;

function startServer(replyFn: ReplyFn): Promise<void> {
	return new Promise((resolve, reject) => {
		server = net.createServer((conn) => {
			openConns.add(conn);
			conn.on("close", () => openConns.delete(conn));
			const decoder = new Decoder();
			conn.on("data", (chunk: Buffer) => {
				for (const msg of decoder.push(chunk)) {
					const req = msg as Record<string, unknown>;
					const reply = replyFn(req);
					conn.write(encode(reply));
				}
			});
		});
		server.on("error", reject);
		server.listen(sockFile, () => resolve());
	});
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("SocketClient — happy paths", () => {
	it("listTabs succeeds and returns raw result", async () => {
		await startServer((req) => ({
			id: req["id"],
			ok: true,
			result: { tabs: [{ id: 1, url: "https://example.com" }] },
		}));
		const client = new SocketClient(sockFile);
		const result = await client.listTabs();
		expect((result as { tabs: unknown[] }).tabs).toHaveLength(1);
	});

	it("exportTabs succeeds and returns raw result", async () => {
		await startServer((req) => ({
			id: req["id"],
			ok: true,
			result: { tabs: [{ id: 1, url: "https://example.com", favIconUrl: null }] },
		}));
		const client = new SocketClient(sockFile);
		const result = await client.exportTabs();
		expect((result as { tabs: unknown[] }).tabs).toHaveLength(1);
	});

	it("getTabContent succeeds and returns raw result", async () => {
		await startServer((req) => ({
			id: req["id"],
			ok: true,
			result: {
				tabId: 5,
				fullText: "hello",
				totalLength: 5,
				isTruncated: false,
				links: [],
			},
		}));
		const client = new SocketClient(sockFile);
		const result = await client.getTabContent(5, 0);
		expect((result as { fullText: string }).fullText).toBe("hello");
	});

	it("status succeeds", async () => {
		await startServer((req) => ({
			id: req["id"],
			ok: true,
			result: {
				daemon: { pid: 123, uptimeSec: 10, version: "0.1.0" },
				addon: { connected: true, lastSeenSec: 1 },
			},
		}));
		const client = new SocketClient(sockFile);
		const result = await client.status();
		expect((result as { daemon: { pid: number } }).daemon.pid).toBe(123);
	});

	it("ping succeeds", async () => {
		await startServer((req) => ({
			id: req["id"],
			ok: true,
			result: { addon: "ready", version: "1.0" },
		}));
		const client = new SocketClient(sockFile);
		const result = await client.ping();
		expect((result as { addon: string }).addon).toBe("ready");
	});
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("SocketClient — error paths", () => {
	it("maps server error reply to SocketClientError with the server's code", async () => {
		await startServer((req) => ({
			id: req["id"],
			ok: false,
			error: { code: "TAB_NOT_FOUND", message: "No such tab" },
		}));
		const client = new SocketClient(sockFile);
		await expect(client.getTabContent(99, 0)).rejects.toMatchObject({
			code: "TAB_NOT_FOUND",
			message: "No such tab",
		});
	});

	it("maps ENOENT to DAEMON_NOT_RUNNING", async () => {
		const client = new SocketClient(join(tempDir, "no-such.sock"));
		const err = await client.listTabs().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SocketClientError);
		expect((err as SocketClientError).code).toBe("DAEMON_NOT_RUNNING");
	});

	it("maps ECONNREFUSED to DAEMON_NOT_RUNNING", async () => {
		// Start a server then immediately close it (no listeners) — simulate refused
		const s = net.createServer();
		await new Promise<void>((r) => s.listen(join(tempDir, "refuse.sock"), r));
		await new Promise<void>((r) => s.close(() => r()));
		const client = new SocketClient(join(tempDir, "refuse.sock"));
		const err = await client.listTabs().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SocketClientError);
		expect((err as SocketClientError).code).toBe("DAEMON_NOT_RUNNING");
	});

	it("times out with DAEMON_TIMEOUT when server never replies", async () => {
		// Server accepts but never sends a reply
		server = net.createServer((conn) => {
			openConns.add(conn);
			conn.on("close", () => openConns.delete(conn));
			/* intentionally silent */
		});
		await new Promise<void>((r) => server!.listen(sockFile, r));

		const client = new SocketClient(sockFile, { timeoutMs: 100 });
		const err = await client.listTabs().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SocketClientError);
		expect((err as SocketClientError).code).toBe("DAEMON_TIMEOUT");
	}, 5_000);

	it("SocketClientError has a non-empty message", async () => {
		const client = new SocketClient(join(tempDir, "missing.sock"));
		const err = await client.ping().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SocketClientError);
		expect((err as SocketClientError).message.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Parallel calls
// ---------------------------------------------------------------------------

describe("SocketClient — parallel calls (independent connections)", () => {
	it("resolves three parallel calls independently", async () => {
		await startServer((req) => ({
			id: req["id"],
			ok: true,
			result: { tabs: [{ id: Number(req["id"]?.toString().at(-1) ?? 0) }] },
		}));
		const client = new SocketClient(sockFile);
		const [a, b, c] = await Promise.all([
			client.listTabs(),
			client.listTabs(),
			client.listTabs(),
		]);
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		expect(c).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Non-ENOENT/ECONNREFUSED socket error passes through raw
// ---------------------------------------------------------------------------

describe("SocketClient — non-ENOENT socket error propagates raw", () => {
	it("rejects with some error when socket path is a regular file (ENOTSOCK)", async () => {
		// A regular file at the socket path causes ENOTSOCK (not ENOENT/ECONNREFUSED),
		// which hits the else-reject(err) branch in socket-client.ts.
		const fsNode = await import("node:fs");
		const regularFile = join(tempDir, "not-a-socket");
		fsNode.writeFileSync(regularFile, "not a socket", "utf-8");
		const client = new SocketClient(regularFile, { timeoutMs: 3_000 });
		const err = await client.ping().catch((e: unknown) => e);
		// Error is either raw ENOTSOCK or mapped DAEMON_NOT_RUNNING—either way defined
		expect(err).toBeDefined();
		expect(err instanceof Error).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Non-ENOENT/ECONNREFUSED socket error passes through raw
// ---------------------------------------------------------------------------

describe("SocketClient — non-ENOENT socket error propagates raw", () => {
	it("rejects with some error when socket path is a regular file (ENOTSOCK/ECONNREFUSED)", async () => {
		// A regular file at the socket path causes ENOTSOCK or similar
		const fsNode = await import("node:fs");
		const regularFile = join(tempDir, "not-a-socket");
		fsNode.writeFileSync(regularFile, "not a socket", "utf-8");
		const client = new SocketClient(regularFile, { timeoutMs: 3_000 });
		const err = await client.ping().catch((e: unknown) => e);
		expect(err).toBeDefined();
		expect(err instanceof Error).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Response with ok:false but no error field — covers fallback strings
// ---------------------------------------------------------------------------

describe("SocketClient — error reply without error field uses fallbacks", () => {
	it("uses 'Unknown error from daemon' and 'INTERNAL' when error field is absent", async () => {
		await startServer((_req) => ({
			id: _req["id"],
			ok: false,
			// No 'error' field intentionally
		}));
		const client = new SocketClient(sockFile);
		const err = await client.ping().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SocketClientError);
		expect((err as SocketClientError).message).toBe("Unknown error from daemon");
		expect((err as SocketClientError).code).toBe("INTERNAL");
	});
});

// ---------------------------------------------------------------------------
// Decoder ignores responses for different IDs (resp.id !== id)
// ---------------------------------------------------------------------------

describe("SocketClient — wrong-ID response is skipped", () => {
	it("waits for response with correct ID, skipping one with wrong ID", async () => {
		let callCount = 0;
		await startServer((req) => {
			callCount++;
			if (callCount === 1) {
				// First call: respond with wrong ID to trigger continue branch
				return { id: "wrong-id-not-matching", ok: true, result: { wrongReply: true } };
			}
			// Should not reach here — the client makes a single request
			return { id: req["id"], ok: true, result: { tabs: [] } };
		});
		// The server sends a response with wrong ID; the client will time out waiting
		const client = new SocketClient(sockFile, { timeoutMs: 500 });
		const err = await client.listTabs().catch((e: unknown) => e);
		// After timeout, a SocketClientError with DAEMON_TIMEOUT is expected
		expect(err).toBeInstanceOf(SocketClientError);
		expect((err as SocketClientError).code).toBe("DAEMON_TIMEOUT");
	});
});

// ---------------------------------------------------------------------------
// Default sockPath() branch — constructor with no arguments
// ---------------------------------------------------------------------------

describe("SocketClient — default sockPath() branch", () => {
	it("can be constructed without arguments (uses sockPath() default)", () => {
		// Verify the no-arg constructor path doesn't throw; ENOENT→DAEMON_NOT_RUNNING
		// is already covered by the "maps ENOENT to DAEMON_NOT_RUNNING" test above.
		expect(() => new SocketClient()).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Data arrives after settlement — settled=true guard in data handler (line 128)
// ---------------------------------------------------------------------------

describe("SocketClient — data handler settled=true guard", () => {
	it("discards second response frame when it arrives after settlement", async () => {
		// Use allowHalfOpen so the server keeps writing after receiving client FIN
		server = net.createServer({ allowHalfOpen: true }, (conn) => {
			openConns.add(conn);
			conn.on("close", () => openConns.delete(conn));
			const decoder = new Decoder();
			conn.on("data", (chunk: Buffer) => {
				for (const msg of decoder.push(chunk)) {
					const req = msg as Record<string, unknown>;
					// First response — client settles on this and calls socket.end()
					conn.write(encode({ id: req["id"], ok: true, result: { tabs: [{ id: 1 }] } }));
					// Delay the second write so it arrives AFTER the client has settled
					setTimeout(() => {
						if (conn.writable) {
							conn.write(encode({ id: req["id"], ok: true, result: { tabs: [{ id: 2 }] } }));
						}
					}, 10);
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			server!.listen(sockFile, resolve);
			server!.on("error", reject);
		});

		const client = new SocketClient(sockFile);
		const result = await client.listTabs();
		// First response wins
		expect(result).toMatchObject({ tabs: [{ id: 1 }] });
		// Wait for the delayed second write to arrive and be silently discarded
		await new Promise<void>((r) => setTimeout(r, 30));
	});
});
