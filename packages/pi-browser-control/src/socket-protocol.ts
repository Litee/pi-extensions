/**
 * Unix socket framing protocol for the pi ↔ daemon channel.
 *
 * Wire format: [UInt32 LE length][UTF-8 JSON body]
 * (Unlike NM framing, the socket protocol always uses little-endian.)
 *
 * Request:  { id, op:"listTabs"|"exportTabs"|"getTabContent"|"closeTab"|"status"|"ping", params? }
 * Response: { id, ok:true, result:... } | { id, ok:false, error:{code,message} }
 */

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/** Encode an object as a length-prefixed LE-UInt32 frame. */
export function encode(obj: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(obj), "utf-8");
	const header = Buffer.allocUnsafe(4);
	header.writeUInt32LE(body.length, 0);
	return Buffer.concat([header, body]);
}

/** Streaming decoder for the unix socket protocol (LE UInt32 prefix). */
export class Decoder {
	private _buf: Buffer = Buffer.alloc(0);

	*push(chunk: Buffer): Generator<unknown, void, unknown> {
		this._buf = Buffer.concat([this._buf, chunk]);

		while (this._buf.length >= 4) {
			const len = this._buf.readUInt32LE(0);

			if (this._buf.length < 4 + len) break;

			const body = this._buf.subarray(4, 4 + len);
			this._buf = this._buf.subarray(4 + len);
			yield JSON.parse(body.toString("utf-8")) as unknown;
		}
	}
}

// ---------------------------------------------------------------------------
// Type shapes
// ---------------------------------------------------------------------------

export type SocketOp = "listTabs" | "exportTabs" | "getTabContent" | "closeTab" | "status" | "ping";

export interface SocketRequest {
	id: string;
	op: SocketOp;
	params?: Record<string, unknown>;
}

export interface SocketErrorInfo {
	code: string;
	message: string;
}

export interface SocketResponse {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: SocketErrorInfo;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

const VALID_OPS: ReadonlySet<string> = new Set<SocketOp>([
	"listTabs",
	"exportTabs",
	"getTabContent",
	"closeTab",
	"status",
	"ping",
]);

export function isSocketRequest(v: unknown): v is SocketRequest {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o["id"] === "string" &&
		typeof o["op"] === "string" &&
		VALID_OPS.has(o["op"])
	);
}

export function isSocketResponse(v: unknown): v is SocketResponse {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return typeof o["id"] === "string" && typeof o["ok"] === "boolean";
}
