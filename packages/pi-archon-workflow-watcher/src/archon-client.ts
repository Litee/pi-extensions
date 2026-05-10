import { execFile } from "node:child_process";

import type { ArchonRun } from "./types.js";

export interface ArchonClient {
	getWorkflowStatus(): Promise<ArchonRun[]>;
}

export class ArchonCliError extends Error {
	constructor(
		message: string,
		public readonly exitCode: number | null,
	) {
		super(message);
		this.name = "ArchonCliError";
	}
}

/**
 * Parse raw archon CLI output. The command emits pino log lines
 * ({"level":30,...}) followed by the actual JSON ({runs:[...]}).
 * Filter out log lines and parse the remainder.
 */
export function parseStatusOutput(raw: string): ArchonRun[] {
	const lines = raw.split("\n");
	// Find lines that are NOT pino log lines (don't start with {"level":)
	const jsonLines = lines.filter(
		(l) => l.trim() !== "" && !l.trim().startsWith('{"level":'),
	);
	if (jsonLines.length === 0) return [];
	try {
		const parsed = JSON.parse(jsonLines.join("\n")) as { runs?: unknown };
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.runs)) {
			return [];
		}
		return parsed.runs
			.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
			.map((r): ArchonRun => {
				const { workflowName, branch, startedAt, lastActivityAt, ...rest } = r;
				const run: ArchonRun = {
					...rest,
					id: typeof r["id"] === "string" ? r["id"] : "",
					status: typeof r["status"] === "string" ? r["status"] : "",
				};
				if (typeof workflowName === "string") run.workflowName = workflowName;
				if (typeof branch === "string") run.branch = branch;
				if (typeof startedAt === "string") run.startedAt = startedAt;
				if (typeof lastActivityAt === "string") run.lastActivityAt = lastActivityAt;
				return run;
			});
	} catch {
		return [];
	}
}

export function createArchonClient(): ArchonClient {
	return {
		getWorkflowStatus(): Promise<ArchonRun[]> {
			return new Promise((resolve, reject) => {
				execFile(
					"archon",
					["workflow", "status", "--json"],
					(err, stdout, stderr) => {
						if (err) {
							reject(
								new ArchonCliError(
									`archon workflow status failed: ${err.message}\nstderr: ${stderr}`,
									err.code as number | null,
								),
							);
							return;
						}
						resolve(parseStatusOutput(stdout));
					},
				);
			});
		},
	};
}
