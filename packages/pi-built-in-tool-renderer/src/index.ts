/**
 * Built-in Tool Renderer Example - Custom rendering for built-in tools
 *
 * Demonstrates how to override the rendering of built-in tools (read, bash,
 * edit, write) without changing their behavior. Each tool is re-registered
 * with the same name, delegating execution to the original implementation
 * while providing compact custom renderCall/renderResult functions.
 *
 * This is useful for users who prefer more concise tool output, or who want
 * to highlight specific information (e.g., showing only the diff stats for
 * edit, or just the exit code for bash).
 *
 * How it works:
 * - registerTool() with the same name as a built-in replaces it entirely
 * - We create instances of the original tools via createReadTool(), etc.
 *   and delegate execute() to them
 * - renderCall() controls what's shown when the tool is invoked
 * - renderResult() controls what's shown after execution completes
 * - The `expanded` flag in renderResult indicates whether the user has
 *   toggled the tool output open (via ctrl+e or clicking)
 *
 * Usage:
 *   pi -e ./built-in-tool-renderer.ts
 */

import type { BashToolDetails, EditToolDetails, ExtensionAPI, FindToolDetails, GrepToolDetails, LsToolDetails, ReadToolDetails } from "@mariozechner/pi-coding-agent";
import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

/**
 * Format a wall-clock duration as `N.Ns` — mirrors the formatter used by the
 * built-in `bash` renderer (`dist/core/tools/bash.js#formatDuration`).
 */
function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

export { formatDuration as __testFormatDuration };

/**
 * Count non-empty result lines from grep / ls / find output.
 *
 * The three built-in tools emit one of these sentinel strings when there is
 * nothing to report; everything else is a newline-separated list of results.
 */
const EMPTY_SENTINELS = new Set([
	"No matches found",
	"No files found matching pattern",
	"(empty directory)",
]);

export function countLines(text: string): number {
	const trimmed = text.trim();
	if (!trimmed || EMPTY_SENTINELS.has(trimmed)) return 0;
	return trimmed.split("\n").filter((l) => l.trim() !== "").length;
}

export { countLines as __testCountLines };

/**
 * Per-invocation render state for the bash tool. `context.state` is typed as
 * `any` by default; we narrow it here so `renderCall` / `renderResult` can
 * share `startedAt`, `endedAt`, and the ticking-timer handle without casts at
 * every access.
 */
interface BashRenderState {
	startedAt?: number | undefined;
	endedAt?: number | undefined;
	interval?: ReturnType<typeof setInterval> | undefined;
}

/**
 * Pull a human-readable failure reason out of the bash tool's error text. The
 * built-in `bash.js` appends one of these sentinels on non-zero / aborted /
 * timed-out runs (see `dist/core/tools/bash.js` — `appendStatus` call sites).
 */
function describeBashFailure(output: string): string {
	const exitMatch = output.match(/Command exited with code (-?\d+)/);
	if (exitMatch) return `exit ${exitMatch[1]}`;
	const timeoutMatch = output.match(/Command timed out after (\d+) seconds/);
	if (timeoutMatch) return `timeout ${timeoutMatch[1]}s`;
	if (/Command aborted/.test(output)) return "aborted";
	return "failed";
}

export { describeBashFailure as __testDescribeBashFailure };

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// --- Read tool: show path and line count ---
	const originalRead = createReadTool(cwd);
	pi.registerTool({
		name: "read",
		label: "read",
		description: originalRead.description,
		parameters: originalRead.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			return originalRead.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("read "));
			text += theme.fg("accent", args.path);
			if (args.offset || args.limit) {
				const parts: string[] = [];
				if (args.offset) parts.push(`offset=${args.offset}`);
				if (args.limit) parts.push(`limit=${args.limit}`);
				text += theme.fg("dim", ` (${parts.join(", ")})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);

			const details = result.details as ReadToolDetails | undefined;
			const content = result.content[0];

			if (content?.type === "image") {
				return new Text(theme.fg("success", "Image loaded"), 0, 0);
			}

			if (content?.type !== "text") {
				return new Text(theme.fg("error", "No content"), 0, 0);
			}

			const lineCount = content.text.split("\n").length;
			let text = theme.fg("success", `${lineCount} lines`);

			if (details?.truncation?.truncated) {
				text += theme.fg("warning", ` (truncated from ${details.truncation.totalLines})`);
			}

			if (expanded) {
				const lines = content.text.split("\n").slice(0, 15);
				for (const line of lines) {
					text += `\n${theme.fg("dim", line)}`;
				}
				if (lineCount > 15) {
					text += `\n${theme.fg("muted", `... ${lineCount - 15} more lines`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// --- Bash tool: command line + status/line-count/duration single-liner ---
	//
	// Colour palette tracks what the built-in renderer uses
	// (`dist/core/tools/bash.js`):
	//   - Command title:  `toolTitle` + bold
	//   - Timeout suffix: `muted`
	//   - Duration:       `muted`
	//   - Output lines:   `toolOutput`
	//   - Truncation:     `warning`
	//
	// Success/failure is *already* conveyed by the outer `ToolExecutionComponent`
	// shell via `toolPendingBg` / `toolSuccessBg` / `toolErrorBg`. We therefore
	// avoid painting the status text green on success (which would fight the
	// shell background) and only emit a `warning`-coloured exit label when
	// `context.isError` is set, which is the authoritative non-zero-exit signal.
	const originalBash = createBashTool(cwd);
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: originalBash.description,
		parameters: originalBash.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			return originalBash.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			const state = context.state as BashRenderState;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const cmd = args.command.length > 80 ? `${args.command.slice(0, 77)}...` : args.command;
			let text = theme.fg("toolTitle", theme.bold(`$ ${cmd}`));
			if (args.timeout) {
				text += theme.fg("muted", ` (timeout: ${args.timeout}s)`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const state = context.state as BashRenderState;

			// Tick the elapsed timer once a second while the command is running.
			if (state.startedAt !== undefined && isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			// Freeze `endedAt` on completion/error. `??=` makes this idempotent
			// against repeated final-render passes.
			if (!isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}

			const duration =
				state.startedAt === undefined
					? undefined
					: formatDuration((state.endedAt ?? Date.now()) - state.startedAt);

			// Still running: show just the elapsed time. Shell background is
			// already `toolPendingBg`, so no extra status text needed.
			if (isPartial && !context.isError) {
				const label = duration ? `Running · ${duration}` : "Running";
				return new Text(theme.fg("muted", label), 0, 0);
			}

			const details = result.details as BashToolDetails | undefined;
			const content = result.content[0];
			const output = content?.type === "text" ? content.text : "";
			const lineCount = output.split("\n").filter((l) => l.trim()).length;

			let text = "";
			if (context.isError) {
				text += theme.fg("warning", describeBashFailure(output));
				if (lineCount > 0) text += theme.fg("muted", ` · ${lineCount} lines`);
			} else {
				text += theme.fg("muted", `${lineCount} lines`);
			}
			if (details?.truncation?.truncated) {
				text += theme.fg("warning", " [truncated]");
			}
			if (duration) {
				text += theme.fg("muted", ` · ${duration}`);
			}

			if (expanded) {
				const lines = output.split("\n").slice(0, 20);
				for (const line of lines) {
					text += `\n${theme.fg("toolOutput", line)}`;
				}
				if (output.split("\n").length > 20) {
					text += `\n${theme.fg("muted", "... more output")}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// --- Edit tool: show path and diff stats ---
	const originalEdit = createEditTool(cwd);
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: originalEdit.description,
		parameters: originalEdit.parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			return originalEdit.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("edit "));
			text += theme.fg("accent", args.path);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Editing..."), 0, 0);

			const details = result.details as EditToolDetails | undefined;
			const content = result.content[0];

			if (content?.type === "text" && content.text.startsWith("Error")) {
				return new Text(theme.fg("error", content.text.split("\n")[0] ?? ""), 0, 0);
			}

			if (!details?.diff) {
				return new Text(theme.fg("success", "Applied"), 0, 0);
			}

			// Count additions and removals from the diff
			const diffLines = details.diff.split("\n");
			let additions = 0;
			let removals = 0;
			for (const line of diffLines) {
				if (line.startsWith("+") && !line.startsWith("+++")) additions++;
				if (line.startsWith("-") && !line.startsWith("---")) removals++;
			}

			let text = theme.fg("success", `+${additions}`);
			text += theme.fg("dim", " / ");
			text += theme.fg("error", `-${removals}`);

			if (expanded) {
				for (const line of diffLines.slice(0, 30)) {
					if (line.startsWith("+") && !line.startsWith("+++")) {
						text += `\n${theme.fg("success", line)}`;
					} else if (line.startsWith("-") && !line.startsWith("---")) {
						text += `\n${theme.fg("error", line)}`;
					} else {
						text += `\n${theme.fg("dim", line)}`;
					}
				}
				if (diffLines.length > 30) {
					text += `\n${theme.fg("muted", `... ${diffLines.length - 30} more diff lines`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// --- Write tool: show path and size ---
	const originalWrite = createWriteTool(cwd);
	pi.registerTool({
		name: "write",
		label: "write",
		description: originalWrite.description,
		parameters: originalWrite.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			return originalWrite.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("write "));
			text += theme.fg("accent", args.path);
			const lineCount = args.content.split("\n").length;
			text += theme.fg("dim", ` (${lineCount} lines)`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Writing..."), 0, 0);

			const content = result.content[0];
			if (content?.type === "text" && content.text.startsWith("Error")) {
				return new Text(theme.fg("error", content.text.split("\n")[0] ?? ""), 0, 0);
			}

			return new Text(theme.fg("success", "Written"), 0, 0);
		},
	});

	// --- Grep tool: pattern + match count ---
	const originalGrep = createGrepTool(cwd);
	pi.registerTool({
		name: "grep",
		label: "grep",
		description: originalGrep.description,
		parameters: originalGrep.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			return originalGrep.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("grep "));
			text += theme.fg("accent", `/${args.pattern}/`);
			text += theme.fg("toolOutput", ` in ${args.path ?? "."}`);
			if (args.glob) text += theme.fg("dim", ` (${args.glob})`);
			if (args.ignoreCase) text += theme.fg("dim", " (i)");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);

			const details = result.details as GrepToolDetails | undefined;
			const content = result.content[0];
			const output = content?.type === "text" ? content.text : "";
			const count = countLines(output);

			let text = count === 0
				? theme.fg("muted", "No matches")
				: theme.fg("success", `${count} match${count === 1 ? "" : "es"}`);

			if (details?.matchLimitReached) text += theme.fg("warning", " (limit reached)");
			if (details?.truncation?.truncated) text += theme.fg("warning", " [truncated]");
			if (details?.linesTruncated) text += theme.fg("warning", " [lines truncated]");

			if (expanded && count > 0) {
				const lines = output.trim().split("\n").slice(0, 30);
				for (const line of lines) text += `\n${theme.fg("toolOutput", line)}`;
				const total = output.trim().split("\n").length;
				if (total > 30) text += `\n${theme.fg("muted", `... ${total - 30} more lines`)}` ;
			}

			return new Text(text, 0, 0);
		},
	});

	// --- Ls tool: path + entry count ---
	const originalLs = createLsTool(cwd);
	pi.registerTool({
		name: "ls",
		label: "ls",
		description: originalLs.description,
		parameters: originalLs.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			return originalLs.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("ls "));
			text += theme.fg("accent", args.path ?? ".");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Listing..."), 0, 0);

			const details = result.details as LsToolDetails | undefined;
			const content = result.content[0];
			const output = content?.type === "text" ? content.text : "";
			const count = countLines(output);

			let text = count === 0
				? theme.fg("muted", "(empty)")
				: theme.fg("success", `${count} entr${count === 1 ? "y" : "ies"}`);

			if (details?.entryLimitReached) text += theme.fg("warning", " (limit reached)");
			if (details?.truncation?.truncated) text += theme.fg("warning", " [truncated]");

			if (expanded && count > 0) {
				const lines = output.trim().split("\n").slice(0, 30);
				for (const line of lines) {
					const styled = line.endsWith("/")
						? theme.fg("accent", line)
						: theme.fg("toolOutput", line);
					text += `\n${styled}`;
				}
				const total = output.trim().split("\n").length;
				if (total > 30) text += `\n${theme.fg("muted", `... ${total - 30} more entries`)}`;
			}

			return new Text(text, 0, 0);
		},
	});

	// --- Find tool: glob pattern + file count ---
	const originalFind = createFindTool(cwd);
	pi.registerTool({
		name: "find",
		label: "find",
		description: originalFind.description,
		parameters: originalFind.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			return originalFind.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("find "));
			text += theme.fg("accent", args.pattern);
			text += theme.fg("toolOutput", ` in ${args.path ?? "."}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);

			const details = result.details as FindToolDetails | undefined;
			const content = result.content[0];
			const output = content?.type === "text" ? content.text : "";
			const count = countLines(output);

			let text = count === 0
				? theme.fg("muted", "No files")
				: theme.fg("success", `${count} file${count === 1 ? "" : "s"}`);

			if (details?.resultLimitReached) text += theme.fg("warning", " (limit reached)");
			if (details?.truncation?.truncated) text += theme.fg("warning", " [truncated]");

			if (expanded && count > 0) {
				const lines = output.trim().split("\n").slice(0, 30);
				for (const line of lines) text += `\n${theme.fg("toolOutput", line)}`;
				const total = output.trim().split("\n").length;
				if (total > 30) text += `\n${theme.fg("muted", `... ${total - 30} more files`)}`;
			}

			return new Text(text, 0, 0);
		},
	});
}
