/**
 * Native-messaging framing for the browser↔daemon channel.
 *
 * Wire format: [UInt32 native-endian length][UTF-8 JSON body]
 * (Firefox native messaging uses native byte order for the length prefix.)
 *
 * IMPORTANT: This module MUST NOT write to process.stdout or process.stderr.
 * All output must go through the caller (daemon.ts) which controls the stdout stream.
 */

import os from "node:os";

const MAX_FRAME_SIZE = 64 * 1024 * 1024; // 64 MB

/**
 * Encode `obj` as a native-messaging frame.
 * The 4-byte length prefix uses the machine's native byte order.
 */
export function encode(obj: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(obj), "utf-8");
	const header = Buffer.allocUnsafe(4);
	if (os.endianness() === "LE") {
		header.writeUInt32LE(body.length, 0);
	} else {
		header.writeUInt32BE(body.length, 0);
	}
	return Buffer.concat([header, body]);
}

/**
 * Streaming decoder that reassembles native-messaging frames from
 * arbitrarily-chunked binary data.
 *
 * Usage:
 *   const decoder = new Decoder();
 *   for (const msg of decoder.push(chunk)) { ... }
 */
export class Decoder {
	private _buf: Buffer = Buffer.alloc(0);

	/**
	 * Push a new chunk of bytes and yield each complete decoded message.
	 * Throws if a declared frame length exceeds 64 MB.
	 */
	*push(chunk: Buffer): Generator<unknown, void, unknown> {
		this._buf = Buffer.concat([this._buf, chunk]);

		while (this._buf.length >= 4) {
			const len =
				os.endianness() === "LE"
					? this._buf.readUInt32LE(0)
					: this._buf.readUInt32BE(0);

			if (len > MAX_FRAME_SIZE) {
				throw new Error(`NM frame too large: ${len} bytes (max ${MAX_FRAME_SIZE})`);
			}

			if (this._buf.length < 4 + len) break;

			const body = this._buf.subarray(4, 4 + len);
			this._buf = this._buf.subarray(4 + len);
			yield JSON.parse(body.toString("utf-8")) as unknown;
		}
	}
}
