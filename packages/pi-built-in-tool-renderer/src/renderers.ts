/**
 * Per-tool pure renderers. Each `render*` function takes `(args, result,
 * theme, context)` and returns `{ call, result }` strings, letting `index.ts`
 * wrap them in `new Text(..., 0, 0)` without holding any rendering logic
 * itself.
 *
 * Theme / context are accepted as structural types so tests can drop in
 * plain-object stubs. The real ExtensionAPI types accept these shapes
 * structurally too (see `ToolRenderContext` in
 * `@earendil-works/pi-coding-agent`).
 */

import { countLines, describeBashFailure, formatDuration } from "./helpers.js";

// ---------------------------------------------------------------------------
// Structural detail shapes
//
// We deliberately do not import the nominal `BashToolDetails` etc. from
// `@earendil-works/pi-coding-agent`: index.ts only hands us `AgentToolResult<unknown>`
// from the `pi`-supplied `renderResult` callback, and upstream's detail
// interfaces are incompatible with `unknown` even though the runtime shape
// matches. We redeclare the minimum subset each renderer reads.
// ---------------------------------------------------------------------------

export interface ReadDetailsLike {
	truncation?: { truncated?: boolean; totalLines?: number } | undefined;
}

export interface BashDetailsLike {
	truncation?: { truncated?: boolean } | undefined;
}

export interface EditDetailsLike {
	diff?: string | undefined;
}

export interface GrepDetailsLike {
	matchLimitReached?: boolean | undefined;
	linesTruncated?: boolean | undefined;
	truncation?: { truncated?: boolean } | undefined;
}

export interface LsDetailsLike {
	entryLimitReached?: boolean | undefined;
	truncation?: { truncated?: boolean } | undefined;
}

export interface FindDetailsLike {
	resultLimitReached?: boolean | undefined;
	truncation?: { truncated?: boolean } | undefined;
}

// ---------------------------------------------------------------------------
// Minimal structural types — avoid pulling in the full `Theme` class / `AgentToolResult`
// so renderers can be tested with tiny object stubs.
// ---------------------------------------------------------------------------

export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface ToolResultLike {
	content: Array<
		| { type: "text"; text: string }
		| { type: "image"; data?: string; mimeType?: string }
		| { type: string; text?: string; [k: string]: unknown }
	>;
	details?: unknown;
}

/**
 * Shared renderer context. Mirrors the subset of `ToolRenderContext` that
 * any of the renderers actually reads.
 */
export interface RenderContext<TState = unknown> {
	state: TState;
	expanded: boolean;
	isPartial: boolean;
	isError: boolean;
	executionStarted: boolean;
	invalidate: () => void;
}

export interface RenderedTool {
	call: string;
	result: string;
}

// ---------------------------------------------------------------------------
// Bash timer state machine
// ---------------------------------------------------------------------------

/**
 * Per-invocation timer state for the bash renderer. The handle is held as
 * `unknown` so that `renderers.ts` does not have to depend on node-specific
 * timer types; callers (index.ts) own the `setInterval` handle.
 */
export interface BashRenderState {
	startedAt?: number | undefined;
	endedAt?: number | undefined;
	interval?: unknown;
}

export interface BashTimerTick {
	/** Label for the "still running" state (empty once the command has finished). */
	label: string;
	/** True once the command has completed/errored — caller should clear its interval. */
	clearTimer: boolean;
}

/**
 * Tick the bash timer state machine.
 *
 * - While `isPartial && !isError`: returns a "Running" / "Running · N.Ns"
 *   label and leaves state untouched.
 * - On completion (`!isPartial` or `isError`): freezes `state.endedAt` (once)
 *   and asks the caller to clear its interval handle.
 */
export function tickBashTimer(
	state: BashRenderState,
	now: number,
	isPartial: boolean,
	isError: boolean,
): BashTimerTick {
	if (!isPartial || isError) {
		state.endedAt ??= now;
		return { label: "", clearTimer: true };
	}
	if (state.startedAt === undefined) {
		return { label: "Running", clearTimer: false };
	}
	return { label: `Running · ${formatDuration(now - state.startedAt)}`, clearTimer: false };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function renderRead(
	args: { path: string; offset?: number; limit?: number },
	result: ToolResultLike | undefined,
	theme: ThemeLike,
	ctx: RenderContext,
): RenderedTool {
	return {
		call: renderReadCall(args, theme),
		result: result ? renderReadResult(result, theme, ctx) : "",
	};
}

function renderReadCall(
	args: { path: string; offset?: number; limit?: number },
	theme: ThemeLike,
): string {
	let text = theme.fg("toolTitle", theme.bold("read "));
	text += theme.fg("accent", args.path);
	if (args.offset || args.limit) {
		const parts: string[] = [];
		if (args.offset) parts.push(`offset=${args.offset}`);
		if (args.limit) parts.push(`limit=${args.limit}`);
		text += theme.fg("dim", ` (${parts.join(", ")})`);
	}
	return text;
}

function renderReadResult(
	result: ToolResultLike,
	theme: ThemeLike,
	ctx: RenderContext,
): string {
	if (ctx.isPartial) return theme.fg("warning", "Reading...");
	const details = result.details as ReadDetailsLike | undefined;
	const content = result.content[0];
	if (content?.type === "image") return theme.fg("success", "Image loaded");
	if (content?.type !== "text" || typeof content.text !== "string") {
		return theme.fg("error", "No content");
	}
	const lineCount = content.text.split("\n").length;
	let text = theme.fg("success", `${lineCount} lines`);
	if (details?.truncation?.truncated) {
		text += theme.fg("warning", ` (truncated from ${details.truncation.totalLines})`);
	}
	if (ctx.expanded) {
		const lines = content.text.split("\n").slice(0, 15);
		for (const line of lines) text += `\n${theme.fg("dim", line)}`;
		if (lineCount > 15) text += `\n${theme.fg("muted", `... ${lineCount - 15} more lines`)}`;
	}
	return text;
}

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

const BASH_COLLAPSED_LIMIT = 80;

export function renderBash(
	args: { command: string; timeout?: number },
	result: ToolResultLike | undefined,
	theme: ThemeLike,
	ctx: RenderContext<BashRenderState>,
	now: number = Date.now(),
): RenderedTool {
	// renderCall side of the house: initialise timer state on first exec tick.
	if (ctx.executionStarted && ctx.state.startedAt === undefined) {
		ctx.state.startedAt = now;
		ctx.state.endedAt = undefined;
	}

	const cmd =
		!ctx.expanded && args.command.length > BASH_COLLAPSED_LIMIT
			? `${args.command.slice(0, BASH_COLLAPSED_LIMIT - 3)}...`
			: args.command;
	let call = theme.fg("toolTitle", theme.bold(`$ ${cmd}`));
	if (args.timeout) call += theme.fg("muted", ` (timeout: ${args.timeout}s)`);

	return { call, result: result ? renderBashResult(result, theme, ctx, now) : "" };
}

function renderBashResult(
	result: ToolResultLike,
	theme: ThemeLike,
	ctx: RenderContext<BashRenderState>,
	now: number,
): string {
	const tick = tickBashTimer(ctx.state, now, ctx.isPartial, ctx.isError);

	// Still running: short-circuit on the running label.
	if (ctx.isPartial && !ctx.isError) {
		return theme.fg("muted", tick.label);
	}

	const duration =
		ctx.state.startedAt === undefined
			? undefined
			: formatDuration((ctx.state.endedAt ?? now) - ctx.state.startedAt);

	const details = result.details as BashDetailsLike | undefined;
	const content = result.content[0];
	const output = content?.type === "text" && typeof content.text === "string" ? content.text : "";
	const lineCount = output.split("\n").filter((l) => l.trim()).length;

	let text = "";
	if (ctx.isError) {
		text += theme.fg("warning", describeBashFailure(output));
		if (lineCount > 0) text += theme.fg("muted", ` · ${lineCount} lines`);
	} else {
		text += theme.fg("muted", `${lineCount} lines`);
	}
	if (details?.truncation?.truncated) text += theme.fg("warning", " [truncated]");
	if (duration) text += theme.fg("muted", ` · ${duration}`);

	if (ctx.expanded) {
		const lines = output.split("\n").slice(0, 20);
		for (const line of lines) text += `\n${theme.fg("toolOutput", line)}`;
		if (output.split("\n").length > 20) {
			text += `\n${theme.fg("muted", "... more output")}`;
		}
	}

	return text;
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export function renderEdit(
	args: { path: string },
	result: ToolResultLike | undefined,
	theme: ThemeLike,
	ctx: RenderContext,
): RenderedTool {
	let call = theme.fg("toolTitle", theme.bold("edit "));
	call += theme.fg("accent", args.path);
	return { call, result: result ? renderEditResult(result, theme, ctx) : "" };
}

function renderEditResult(
	result: ToolResultLike,
	theme: ThemeLike,
	ctx: RenderContext,
): string {
	if (ctx.isPartial) return theme.fg("warning", "Editing...");
	const details = result.details as EditDetailsLike | undefined;
	const content = result.content[0];
	if (content?.type === "text" && typeof content.text === "string" && content.text.startsWith("Error")) {
		return theme.fg("error", content.text.split("\n")[0] ?? "");
	}
	if (!details?.diff) return theme.fg("success", "Applied");

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

	if (ctx.expanded) {
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

	return text;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function renderWrite(
	args: { path: string; content: string },
	result: ToolResultLike | undefined,
	theme: ThemeLike,
	ctx: RenderContext,
): RenderedTool {
	let call = theme.fg("toolTitle", theme.bold("write "));
	call += theme.fg("accent", args.path);
	const lineCount = args.content.split("\n").length;
	call += theme.fg("dim", ` (${lineCount} lines)`);
	return { call, result: result ? renderWriteResult(result, theme, ctx) : "" };
}

function renderWriteResult(
	result: ToolResultLike,
	theme: ThemeLike,
	ctx: RenderContext,
): string {
	if (ctx.isPartial) return theme.fg("warning", "Writing...");
	const content = result.content[0];
	if (content?.type === "text" && typeof content.text === "string" && content.text.startsWith("Error")) {
		return theme.fg("error", content.text.split("\n")[0] ?? "");
	}
	return theme.fg("success", "Written");
}

// ---------------------------------------------------------------------------
// Grep
// ---------------------------------------------------------------------------

export function renderGrep(
	args: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean },
	result: ToolResultLike | undefined,
	theme: ThemeLike,
	ctx: RenderContext,
): RenderedTool {
	let call = theme.fg("toolTitle", theme.bold("grep "));
	call += theme.fg("accent", `/${args.pattern}/`);
	call += theme.fg("toolOutput", ` in ${args.path ?? "."}`);
	if (args.glob) call += theme.fg("dim", ` (${args.glob})`);
	if (args.ignoreCase) call += theme.fg("dim", " (i)");
	return { call, result: result ? renderGrepResult(result, theme, ctx) : "" };
}

function renderGrepResult(
	result: ToolResultLike,
	theme: ThemeLike,
	ctx: RenderContext,
): string {
	if (ctx.isPartial) return theme.fg("warning", "Searching...");
	const details = result.details as GrepDetailsLike | undefined;
	const content = result.content[0];
	const output = content?.type === "text" && typeof content.text === "string" ? content.text : "";
	const count = countLines(output);

	let text =
		count === 0
			? theme.fg("muted", "No matches")
			: theme.fg("success", `${count} match${count === 1 ? "" : "es"}`);

	if (details?.matchLimitReached) text += theme.fg("warning", " (limit reached)");
	if (details?.truncation?.truncated) text += theme.fg("warning", " [truncated]");
	if (details?.linesTruncated) text += theme.fg("warning", " [lines truncated]");

	if (ctx.expanded && count > 0) {
		const lines = output.trim().split("\n").slice(0, 30);
		for (const line of lines) text += `\n${theme.fg("toolOutput", line)}`;
		const total = output.trim().split("\n").length;
		if (total > 30) text += `\n${theme.fg("muted", `... ${total - 30} more lines`)}`;
	}

	return text;
}

// ---------------------------------------------------------------------------
// Ls
// ---------------------------------------------------------------------------

export function renderLs(
	args: { path?: string },
	result: ToolResultLike | undefined,
	theme: ThemeLike,
	ctx: RenderContext,
): RenderedTool {
	let call = theme.fg("toolTitle", theme.bold("ls "));
	call += theme.fg("accent", args.path ?? ".");
	return { call, result: result ? renderLsResult(result, theme, ctx) : "" };
}

function renderLsResult(
	result: ToolResultLike,
	theme: ThemeLike,
	ctx: RenderContext,
): string {
	if (ctx.isPartial) return theme.fg("warning", "Listing...");
	const details = result.details as LsDetailsLike | undefined;
	const content = result.content[0];
	const output = content?.type === "text" && typeof content.text === "string" ? content.text : "";
	const count = countLines(output);

	let text =
		count === 0
			? theme.fg("muted", "(empty)")
			: theme.fg("success", `${count} entr${count === 1 ? "y" : "ies"}`);

	if (details?.entryLimitReached) text += theme.fg("warning", " (limit reached)");
	if (details?.truncation?.truncated) text += theme.fg("warning", " [truncated]");

	if (ctx.expanded && count > 0) {
		const lines = output.trim().split("\n").slice(0, 30);
		for (const line of lines) {
			const styled = line.endsWith("/") ? theme.fg("accent", line) : theme.fg("toolOutput", line);
			text += `\n${styled}`;
		}
		const total = output.trim().split("\n").length;
		if (total > 30) text += `\n${theme.fg("muted", `... ${total - 30} more entries`)}`;
	}

	return text;
}

// ---------------------------------------------------------------------------
// Find
// ---------------------------------------------------------------------------

export function renderFind(
	args: { pattern: string; path?: string },
	result: ToolResultLike | undefined,
	theme: ThemeLike,
	ctx: RenderContext,
): RenderedTool {
	let call = theme.fg("toolTitle", theme.bold("find "));
	call += theme.fg("accent", args.pattern);
	call += theme.fg("toolOutput", ` in ${args.path ?? "."}`);
	return { call, result: result ? renderFindResult(result, theme, ctx) : "" };
}

function renderFindResult(
	result: ToolResultLike,
	theme: ThemeLike,
	ctx: RenderContext,
): string {
	if (ctx.isPartial) return theme.fg("warning", "Searching...");
	const details = result.details as FindDetailsLike | undefined;
	const content = result.content[0];
	const output = content?.type === "text" && typeof content.text === "string" ? content.text : "";
	const count = countLines(output);

	let text =
		count === 0
			? theme.fg("muted", "No files")
			: theme.fg("success", `${count} file${count === 1 ? "" : "s"}`);

	if (details?.resultLimitReached) text += theme.fg("warning", " (limit reached)");
	if (details?.truncation?.truncated) text += theme.fg("warning", " [truncated]");

	if (ctx.expanded && count > 0) {
		const lines = output.trim().split("\n").slice(0, 30);
		for (const line of lines) text += `\n${theme.fg("toolOutput", line)}`;
		const total = output.trim().split("\n").length;
		if (total > 30) text += `\n${theme.fg("muted", `... ${total - 30} more files`)}`;
	}

	return text;
}
