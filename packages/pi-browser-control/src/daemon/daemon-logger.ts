/**
 * File-appending logger for the pi-browser-control daemon.
 *
 * CRITICAL: This logger MUST NOT write to process.stdout or process.stderr.
 * Any output to stdout corrupts the native-messaging stream.
 * All log entries go to a file via fs.appendFile (fire-and-forget).
 */

import fs from "node:fs";
import { logPath } from "../socket-paths.ts";

interface LogEntry {
	ts: string;
	level: string;
	msg: string;
	data?: unknown;
}

export class DaemonLogger {
	private readonly _path: string;

	constructor(path?: string) {
		this._path = path ?? logPath();
	}

	info(msg: string, data?: unknown): void {
		this._append("INFO", msg, data);
	}

	warn(msg: string, data?: unknown): void {
		this._append("WARN", msg, data);
	}

	error(msg: string, data?: unknown): void {
		this._append("ERROR", msg, data);
	}

	private _append(level: string, msg: string, data?: unknown): void {
		const entry: LogEntry = {
			ts: new Date().toISOString(),
			level,
			msg,
			...(data !== undefined ? { data } : {}),
		};
		// Fire-and-forget: errors are silently ignored to avoid stdout contamination
		fs.appendFile(this._path, JSON.stringify(entry) + "\n", "utf-8", () => {
			// intentionally empty — cannot report errors without risking stdout writes
		});
	}
}
