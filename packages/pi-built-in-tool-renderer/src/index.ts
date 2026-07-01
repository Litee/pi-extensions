/**
 * Built-in Tool Renderer Example - Custom rendering for built-in tools
 *
 * Demonstrates how to override the rendering of built-in tools (read, bash,
 * edit, write, grep, ls, find) without changing their behavior. Each tool is
 * re-registered with the same name, delegating execution to the original
 * implementation while providing compact custom renderCall/renderResult
 * functions.
 *
 * All pure rendering logic lives in `renderers.ts`; all pure helpers live in
 * `helpers.ts`. This file is just the `pi.registerTool(...)` wiring plus the
 * side-effectful `setInterval` / `clearInterval` dance for the bash timer.
 *
 * Usage:
 *   pi -e ./built-in-tool-renderer.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";

import {
	type BashRenderState,
	type RenderContext,
	type ThemeLike,
	renderBash,
	renderBashCallLines,
	renderFind,
	renderGrep,
	renderLs,
	renderRead,
	tickBashTimer,
} from "./renderers.js";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// --- read ---
	const originalRead = createReadTool(cwd);
	pi.registerTool({
		name: "read",
		label: "read",
		description: originalRead.description,
		parameters: originalRead.parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			return originalRead.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, ctx) {
			return new Text(renderRead(args, undefined, theme, ctx).call, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const view = renderRead(args(ctx), result, theme, mergeOptions(ctx, expanded, isPartial));
			return new Text(view.result, 0, 0);
		},
	});

	// --- bash ---
	//
	// Colour palette tracks the built-in renderer (`dist/core/tools/bash.js`).
	// Success/failure is already conveyed by the outer `ToolExecutionComponent`
	// shell background — we deliberately do not paint success green here.
	const originalBash = createBashTool(cwd);
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: originalBash.description,
		parameters: originalBash.parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			return originalBash.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(bashArgs, theme, ctx) {
			// Side effect only: prime the timer state on the first exec tick.
			renderBash(bashArgs, undefined, theme, ctxWithBashState(ctx));
			return new BashCallLines(bashArgs.command, theme, ctx.expanded);
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const state = stateAs<BashRenderState>(ctx);
			const typed = mergeOptions(ctx, expanded, isPartial);

			// Side effect: keep a 1s ticker alive while the command is running so
			// the elapsed duration stays fresh. `tickBashTimer` (pure) drives
			// interval lifecycle decisions; this block just translates them to
			// actual Node timer handles.
			if (state.startedAt !== undefined && typed.isPartial && state.interval === undefined) {
				state.interval = setInterval(() => typed.invalidate(), 1000);
			}
			const tick = tickBashTimer(state, Date.now(), typed.isPartial, typed.isError);
			if (tick.clearTimer && state.interval !== undefined) {
				clearInterval(state.interval as ReturnType<typeof setInterval>);
				state.interval = undefined;
			}

			const view = renderBash(args(typed), result, theme, ctxWithBashState(typed));
			return new Text(view.result, 0, 0);
		},
	});

	// --- edit --- disabled — delegated to pi-diff
	// --- write --- disabled — delegated to pi-diff

	// --- grep ---
	const originalGrep = createGrepTool(cwd);
	pi.registerTool({
		name: "grep",
		label: "grep",
		description: originalGrep.description,
		parameters: originalGrep.parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			return originalGrep.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(grepArgs, theme, ctx) {
			return new Text(renderGrep(grepArgs, undefined, theme, ctx).call, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const view = renderGrep(args(ctx), result, theme, mergeOptions(ctx, expanded, isPartial));
			return new Text(view.result, 0, 0);
		},
	});

	// --- ls ---
	const originalLs = createLsTool(cwd);
	pi.registerTool({
		name: "ls",
		label: "ls",
		description: originalLs.description,
		parameters: originalLs.parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			return originalLs.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(lsArgs, theme, ctx) {
			return new Text(renderLs(lsArgs, undefined, theme, ctx).call, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const view = renderLs(args(ctx), result, theme, mergeOptions(ctx, expanded, isPartial));
			return new Text(view.result, 0, 0);
		},
	});

	// --- find ---
	const originalFind = createFindTool(cwd);
	pi.registerTool({
		name: "find",
		label: "find",
		description: originalFind.description,
		parameters: originalFind.parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			return originalFind.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(findArgs, theme, ctx) {
			return new Text(renderFind(findArgs, undefined, theme, ctx).call, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const view = renderFind(args(ctx), result, theme, mergeOptions(ctx, expanded, isPartial));
			return new Text(view.result, 0, 0);
		},
	});
}

// ---------------------------------------------------------------------------
// Tiny adapter helpers.
//
// `pi`'s `renderResult` signature passes (expanded, isPartial) in `options`
// separately from `context`; the pure renderers read them off a single
// `RenderContext`. These helpers paper over that difference without pulling
// in a reducer.
// ---------------------------------------------------------------------------

interface CtxLike {
	args: unknown;
	state: unknown;
	expanded: boolean;
	isPartial: boolean;
	isError: boolean;
	executionStarted: boolean;
	invalidate: () => void;
}

function args<T>(ctx: CtxLike): T {
	return ctx.args as T;
}

function mergeOptions(ctx: CtxLike, expanded: boolean, isPartial: boolean): CtxLike {
	// Options win (they're what the rendering pass is actually for); everything
	// else we forward as-is.
	return { ...ctx, expanded, isPartial };
}

function stateAs<T>(ctx: CtxLike): T {
	return ctx.state as T;
}

function ctxWithBashState(ctx: CtxLike): RenderContext<BashRenderState> {
	// `ctx.state` is typed as `any` in the ExtensionAPI; narrow it here once
	// so renderers.ts sees the concrete shape.
	return ctx as unknown as RenderContext<BashRenderState>;
}

/**
 * Width-aware component for the bash call line.
 *
 * Recomputed every render so the result re-clips / re-wraps when the pane
 * resizes. `expanded` is captured at construction time — pi rebuilds the
  * component on each render pass with the latest `ctx.expanded`.
 */
class BashCallLines implements Component {
	constructor(
		private readonly command: string | undefined,
		private readonly theme: ThemeLike,
		private readonly expanded: boolean,
	) {}

	render(width: number): string[] {
		return renderBashCallLines(this.command, this.theme, this.expanded, width);
	}

	invalidate(): void {
		// Stateless — nothing to invalidate. Width changes are handled in render().
	}
}
