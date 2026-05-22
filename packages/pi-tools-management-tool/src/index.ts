/**
 * pi-tools-management-tool — Pi extension.
 *
 * Registers a `manage_tools` tool so the LLM can list, activate, deactivate,
 * and reset its own tool set at runtime. Built on top of pi's own runtime
 * tool-management API (`pi.getAllTools` / `pi.getActiveTools` /
 * `pi.setActiveTools`).
 *
 * ## Auto-continue
 *
 * pi's agent loop snapshots `tools` once per `agent.prompt()` call (see
 * `@earendil-works/pi-agent-core/dist/agent.js` createContextSnapshot, which
 * does `tools: this._state.tools.slice()`). Inside one run that snapshot is
 * frozen — even though `pi.setActiveTools()` mutates `_state.tools` live,
 * subsequent LLM calls within the same run still see the stale tool list.
 * Steering and follow-up queues drained mid-run reuse the same stale snapshot.
 * The new tool list only becomes visible on the next fresh `agent.prompt()`.
 *
 * To paper over this, this extension:
 *
 * 1. Returns `terminate: true` on tool results that flipped tools from
 *    inactive→active. The agent loop only honors `terminate` when EVERY tool
 *    in a batch sets it (`agent-loop.js:315`), so this ends the run early
 *    when `manage_tools` is alone in its batch and is silently ignored when
 *    batched with other tools.
 *
 * 2. Listens on `agent_end`. When the run that just finished contained ANY
 *    `manage_tools` call (including list, deactivate, and no-op activate),
 *    schedules `pi.sendMessage({display:false}, {triggerTurn:true})` via
 *    `setTimeout(0)`. The deferral is required because `finishRun()` — which
 *    sets `agent.state.isStreaming = false` and thus makes `ctx.isIdle()`
 *    return `true` — runs in the `finally` block of `runWithLifecycle` AFTER
 *    all `agent_end` listeners complete. Without the deferral, `isStreaming`
 *    is still `true` when the listener fires: `sendMessage` would fall into
 *    the steer queue instead of starting a fresh `agent.prompt()`. The
 *    macrotask (setTimeout) fires only after all pending microtasks (including
 *    the `finishRun()` continuation) have settled, guaranteeing the session is
 *    truly idle when the message is delivered.
 *
 * Several guards keep the auto-continue from going wrong:
 *
 * - Activate-then-deactivate in the same run: filter `pendingRefresh` against
 *   the live active set at `agent_end` to determine whether to advertise
 *   newly-available tools; does NOT suppress the refresh entirely (the LLM
 *   still needs a turn after the deactivation too).
 * - Loop guard: if the LLM already used any of the newly activated tools
 *   after the last manage_tools toolCall in the run, don't nudge. For
 *   list/deactivate/no-op paths trulyAvailable is empty so this guard is
 *   inert — MAX_AUTO_REFRESHES is the only loop protection in those cases.
 * - Stop reason: only auto-continue on "stop" or "toolUse" (clean turn ends).
 *   Skip "error", "aborted", "length".
 * - Race / extension collision: inside the deferred setTimeout callback,
 *   check `ctx.isIdle()` before sending. Defends against another extension
 *   having started a turn in the window between `agent_end` and the macrotask.
 * - Counter cap: at most `MAX_AUTO_REFRESHES` consecutive auto-refreshes
 *   between user-initiated turns; surface via `ctx.ui.notify` if exceeded.
 *
 * ## Other design decisions
 *
 *   - `manage_tools` itself is PROTECTED: deactivating it is silently refused
 *     so the LLM can't lock itself out.
 *   - `reset` restores the active set captured at `session_start`. The
 *     snapshot is retaken on every session_start event (new / resume / fork).
 *   - Unknown tool names are silently dropped and reported back in the
 *     result text so the LLM can correct itself.
 *   - No filesystem or network I/O. Only pi APIs are touched.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AgentEndEvent,
	AgentStartEvent,
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { computeNext, type Action } from "./manager.js";

const TOOL_NAME = "manage_tools";
const PROTECTED: ReadonlySet<string> = new Set([TOOL_NAME]);

/**
 * Cap on consecutive auto-refreshes between user-initiated turns. After this
 * many in a row without an intervening user turn, suppress and surface a
 * warning via `ctx.ui.notify` so the user knows to take over.
 */
const MAX_AUTO_REFRESHES = 3;

/** Custom-message type used for the auto-refresh transcript artifact. */
const REFRESH_CUSTOM_TYPE = "pi-tools-management-tool:refresh";

/**
 * Stop reasons that count as a clean end-of-turn (we may auto-continue).
 * Other values ("error", "aborted", "length") indicate the run did not end
 * cleanly and the user (or another extension) should drive the next step.
 *
 * `StopReason` from `@earendil-works/pi-ai` is `"stop" | "length" | "toolUse"
 * | "error" | "aborted"`.
 */
const SAFE_STOP_REASONS: ReadonlySet<string> = new Set(["stop", "toolUse"]);

const DESCRIPTION = `List, activate, deactivate, or reset the tools available to you. Use this to focus your toolbox for a subtask — for example, disable edit/write during pure exploration, or activate a dynamically-registered tool you need.

Actions:
- "list": return every registered tool with its active/inactive state and description. No effect on the tool set.
- "activate": enable one or more tools by name. Idempotent. Unknown names are silently dropped.
- "deactivate": disable one or more tools by name. Idempotent. Protected tools (like manage_tools itself) are silently refused.
- "reset": restore the active set that was in effect at session_start. Useful to undo your own changes after a subtask.

Notes:
- After activating (or after reset re-enables tools), the agent usually auto-continues so newly available tools become callable on the very next assistant message — no human nudge required. If for any reason the auto-continue does not happen (e.g. another extension already triggered a turn), the user can re-prompt.
- manage_tools can never deactivate itself. You always retain the ability to reset.
- Activate/deactivate accept multiple tool names at once via the "tools" array.`;

const PROMPT_GUIDELINES = [
	"Prefer manage_tools when the user asks to narrow or expand the toolbox, instead of asking them to toggle tools by hand.",
	"After activating, the agent will usually auto-continue so newly activated tools become callable on the next assistant message.",
	"manage_tools cannot disable itself, so you can always call manage_tools({action:\"reset\"}) to recover.",
	"Use manage_tools({action:\"list\"}) before activating unfamiliar tools so you see their real names and descriptions.",
];

const ParamsSchema = Type.Object({
	action: StringEnum(["list", "activate", "deactivate", "reset"] as const),
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description: "Tool names to activate or deactivate. Ignored for list and reset.",
		}),
	),
});

interface ListingRow {
	name: string;
	active: boolean;
	description: string;
}

function buildListing(all: readonly ToolInfo[], active: ReadonlySet<string>): ListingRow[] {
	return [...all]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((t) => ({
			name: t.name,
			active: active.has(t.name),
			description: typeof t.description === "string" ? t.description : "",
		}));
}

function renderListing(rows: ListingRow[]): string {
	const header = `tools (${rows.filter((r) => r.active).length} active / ${rows.length} total):`;
	const lines = rows.map((r) => {
		const mark = r.active ? "[x]" : "[ ]";
		const desc = r.description ? ` — ${r.description.split("\n")[0]}` : "";
		return `  ${mark} ${r.name}${desc}`;
	});
	return [header, ...lines].join("\n");
}

/**
 * Names that are in `after` but not `before`. Pure helper.
 */
function pickAddedFromDiff(
	before: ReadonlySet<string>,
	after: ReadonlySet<string>,
): Set<string> {
	const added = new Set<string>();
	for (const name of after) {
		if (!before.has(name)) added.add(name);
	}
	return added;
}

/**
 * Names that are in `before` but not `after`. Pure helper.
 */
function pickRemovedFromDiff(
	before: ReadonlySet<string>,
	after: ReadonlySet<string>,
): Set<string> {
	const removed = new Set<string>();
	for (const name of before) {
		if (!after.has(name)) removed.add(name);
	}
	return removed;
}

/**
 * Last assistant message's stopReason in the run, if any.
 */
function lastAssistantStopReason(messages: readonly AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m && m.role === "assistant") {
			const sr = (m as { stopReason?: unknown }).stopReason;
			return typeof sr === "string" ? sr : undefined;
		}
	}
	return undefined;
}

/**
 * True iff some assistant message AFTER the last `manage_tools` toolCall
 * issued a toolCall whose name is in `names`. This is the loop guard for
 * auto-continue: if the LLM has already exercised the freshly-activated
 * tools, there's nothing for us to nudge.
 *
 * We deliberately scope to "after the last manage_tools call" rather than
 * "anywhere in the run" so that an unrelated earlier toolCall of the same
 * name (e.g. activate-deactivate-reactivate) doesn't suppress a legitimate
 * refresh.
 */
function calledAnyAfterLastActivation(
	messages: readonly AgentMessage[],
	names: ReadonlySet<string>,
): boolean {
	let lastIdx = -1;
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (!m || m.role !== "assistant") continue;
		for (const c of m.content) {
			if (c.type === "toolCall" && c.name === TOOL_NAME) lastIdx = i;
		}
	}
	if (lastIdx === -1) return false;
	for (let i = lastIdx + 1; i < messages.length; i++) {
		const m = messages[i];
		if (!m || m.role !== "assistant") continue;
		for (const c of m.content) {
			if (c.type === "toolCall" && names.has(c.name)) return true;
		}
	}
	return false;
}

export default function manageToolsExtension(pi: ExtensionAPI): void {
	let startupActive: Set<string> = new Set();

	// --- Auto-continue closure state -----------------------------------------
	// Non-null whenever manage_tools was called during the current run.
	// Contains the names that flipped inactive→active so the refresh message
	// can advertise them. Empty set = call happened but no tools were added
	// (e.g. list, deactivate, or no-op activate). Cleared on every agent_end
	// whether we fire a refresh or skip.
	let pendingRefresh: Set<string> | null = null;
	// Consecutive auto-refreshes, reset on user-initiated agent_start.
	let consecutiveAutoRefreshes = 0;
	// Set when we fire a refresh so the next agent_start knows the upcoming
	// run was triggered by us (don't reset the counter), and unset otherwise
	// (a fresh user prompt does reset).
	let lastWasAutoRefresh = false;
	// -------------------------------------------------------------------------

	pi.on("session_start", (_event, _ctx) => {
		// Defensive: make sure PROTECTED tools are actually in the live active
		// set, even if the user disabled them via /tools or a prior extension.
		// Without this, the LLM could resume a session with manage_tools
		// deactivated and be unable to recover.
		const liveActive = new Set(pi.getActiveTools());
		let mutated = false;
		for (const p of PROTECTED) {
			if (!liveActive.has(p)) {
				liveActive.add(p);
				mutated = true;
			}
		}
		if (mutated) pi.setActiveTools([...liveActive]);

		startupActive = new Set(liveActive);

		// Reset auto-continue state on every session_start (new/resume/fork)
		// so a resumed session never replays a stale pending refresh.
		pendingRefresh = null;
		consecutiveAutoRefreshes = 0;
		lastWasAutoRefresh = false;
	});

	pi.on("agent_start", (_event: AgentStartEvent, _ctx: ExtensionContext) => {
		// If the run we're starting was kicked off by our own auto-refresh,
		// keep the counter intact so a long bounce eventually trips the cap.
		// Otherwise reset — a user-initiated turn is fresh ground.
		if (lastWasAutoRefresh) {
			lastWasAutoRefresh = false;
		} else {
			consecutiveAutoRefreshes = 0;
		}
	});

	pi.on("agent_end", (event: AgentEndEvent, ctx: ExtensionContext) => {
		// Drain pendingRefresh unconditionally — if we bail below, we still
		// don't want to act on it later.
		const refresh = pendingRefresh;
		pendingRefresh = null;
		// Bail only when manage_tools was never called this run (refresh is null).
		// An empty set is a valid sentinel meaning "call happened but no tools
		// were activated" — we still need to fire a refresh in that case.
		if (refresh === null) return;

		// NOTE: do NOT check ctx.isIdle() here. isStreaming is still true when
		// agent_end listeners fire — finishRun() only runs in the finally block
		// of runWithLifecycle AFTER all listeners complete. Checking isIdle()
		// here always returns false and would always bail. The race guard is
		// instead applied inside the deferred setTimeout below.

		// Only auto-continue on clean turn ends.
		const stopReason = lastAssistantStopReason(event.messages);
		if (stopReason !== undefined && !SAFE_STOP_REASONS.has(stopReason)) return;

		// Filter against the live active set: a tool flipped on then off in
		// the same run shouldn't be advertised as "newly available", but a
		// refresh is still required (the LLM needs a turn after any
		// manage_tools call, not only after activation).
		const live = new Set(pi.getActiveTools());
		const trulyAvailable = new Set<string>();
		for (const name of refresh) {
			if (live.has(name)) trulyAvailable.add(name);
		}
		// NOTE: we intentionally do NOT return early when trulyAvailable is
		// empty. pendingRefresh being non-null already guarantees manage_tools
		// was called this run — the LLM needs a new turn regardless of whether
		// the tool set actually changed.

		// Loop guard: if the LLM already used any of these AFTER the last
		// manage_tools toolCall, there's nothing to nudge.
		// Note: when trulyAvailable is empty (list/deactivate/no-op), this guard
		// is vacuously false and cannot suppress. MAX_AUTO_REFRESHES is the only
		// protection against infinite loops in those paths.
		if (calledAnyAfterLastActivation(event.messages, trulyAvailable)) return;

		// Cap consecutive auto-refreshes between user-initiated turns.
		if (consecutiveAutoRefreshes >= MAX_AUTO_REFRESHES) {
			ctx.ui?.notify?.(
				`manage_tools auto-continue suppressed (>= ${MAX_AUTO_REFRESHES} in a row). Type a follow-up to continue.`,
				"warning",
			);
			return;
		}

		const sorted = [...trulyAvailable].sort();
		const content =
			trulyAvailable.size > 0
				? `Continue. Newly available tools: ${sorted.join(", ")}. Use them as appropriate for the current task.`
				: `Continue. Use your tools as appropriate for the current task.`;

		// Defer via setTimeout(0) so this macrotask runs only after all pending
		// microtasks settle — including the finishRun() continuation in
		// runWithLifecycle's finally block that sets isStreaming = false.
		// Without the deferral, sendMessage falls into the steer queue
		// (isStreaming still true) and never triggers a new agent turn.
		setTimeout(() => {
			// Race / extension-collision guard: check here (post-finishRun) rather
			// than in the synchronous agent_end body (where isIdle() is always
			// false). If another extension already started a new run in the window
			// between agent_end and this macrotask, bail.
			if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;

			// Mark BEFORE sending: agent_start fires synchronously inside
			// sendMessage's triggerTurn path, so the flag must be set first.
			consecutiveAutoRefreshes += 1;
			lastWasAutoRefresh = true;

			pi.sendMessage(
				{
					customType: REFRESH_CUSTOM_TYPE,
					content,
					display: false,
				},
				{ triggerTurn: true },
			);
		}, 0);
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Manage Tools",
		description: DESCRIPTION,
		promptSnippet:
			"List, activate, deactivate, or reset your own tools at runtime. After activating, the agent usually auto-continues so the new tools are callable on the next assistant message.",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ParamsSchema,

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("muted", "..."), 0, 0);

			interface DetailsShape {
				action: Action;
				active: string[];
				total: number;
				rows: ListingRow[];
				changed?: { activated: string[]; deactivated: string[] };
				ignoredUnknown: string[];
				ignoredProtected: string[];
			}
			const d = result.details as DetailsShape | undefined;
			const activeCount = d?.active.length ?? 0;
			const total = d?.total ?? 0;

			let text =
				theme.fg("success", `${activeCount} active`) +
				theme.fg("dim", ` / ${total} total`);

			if (!expanded) {
				text += theme.fg("dim", " — … ctrl+o to expand");
			} else if (d?.action === undefined || d?.action === "list") {
				// Full roster on `list`, and as a back-compat fallback for results
				// persisted by an earlier version of this extension that did not set
				// `details.action` — those replays would otherwise hit the diff
				// branch with no `changed` data and render "No changes." (#0003).
				const rows = d?.rows ?? [];
				for (const row of rows) {
					const mark = row.active
						? theme.fg("success", "[x]")
						: theme.fg("dim", "[ ]");
					const desc = row.description
						? theme.fg("dim", ` — ${row.description.split("\n")[0]}`)
						: "";
					text += `\n  ${mark} ${theme.bold(row.name)}${desc}`;
				}
			} else {
				// activate / deactivate / reset — show only the diff. (#0003)
				const activated = d?.changed?.activated ?? [];
				const deactivated = d?.changed?.deactivated ?? [];
				if (activated.length === 0 && deactivated.length === 0) {
					text += `\n  ${theme.fg("dim", "No changes.")}`;
				} else {
					if (activated.length > 0) {
						text += `\n  ${theme.fg("success", `✓ Activated:`)} ${theme.bold(activated.join(", "))}`;
					}
					if (deactivated.length > 0) {
						text += `\n  ${theme.fg("warning", `✗ Deactivated:`)} ${theme.bold(deactivated.join(", "))}`;
					}
				}
			}

			if (d?.ignoredUnknown?.length) {
				text += `\n${theme.fg("warning", `Ignored unknown: ${d.ignoredUnknown.join(", ")}`)}` ;
			}
			if (d?.ignoredProtected?.length) {
				text += `\n${theme.fg("warning", `Refused (protected): ${d.ignoredProtected.join(", ")}`)}` ;
			}

			return new Text(text, 0, 0);
		},

		execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const all = pi.getAllTools();
			const knownTools = new Set(all.map((t) => t.name));
			const currentActive = new Set(pi.getActiveTools());

			const result = computeNext({
				action: params.action,
				...(params.tools !== undefined ? { tools: params.tools } : {}),
				currentActive,
				startupActive,
				knownTools,
				protectedTools: PROTECTED,
			});

			let added: Set<string> = new Set();
			let removed: Set<string> = new Set();
			if (result.nextActive) {
				added = pickAddedFromDiff(currentActive, result.nextActive);
				removed = pickRemovedFromDiff(currentActive, result.nextActive);
				pi.setActiveTools([...result.nextActive]);
			}

			// Auto-continue accumulator. Always mark that manage_tools was called
			// (pendingRefresh becomes non-null). Accumulate activated names across
			// multiple calls in the same run; for list/deactivate/no-op activate
			// the set stays empty but is still non-null (sentinel).
			if (pendingRefresh === null) {
				pendingRefresh = new Set(added);
			} else {
				for (const n of added) pendingRefresh.add(n);
			}

			// Compose the response for the LLM.
			const listing = buildListing(
				pi.getAllTools(),
				new Set(pi.getActiveTools()),
			);

			const parts: string[] = [];
			switch (params.action) {
				case "list":
					parts.push(renderListing(listing));
					break;
				case "activate": {
					const activated = listing.filter((r) => r.active).map((r) => r.name);
					parts.push(`Active tools now: ${activated.join(", ")}`);
					if (result.ignoredUnknown.length > 0) {
						parts.push(`Ignored unknown: ${result.ignoredUnknown.join(", ")}`);
					}
					break;
				}
				case "deactivate": {
					const activated = listing.filter((r) => r.active).map((r) => r.name);
					parts.push(`Active tools now: ${activated.join(", ")}`);
					if (result.ignoredProtected.length > 0) {
						parts.push(`Refused (protected): ${result.ignoredProtected.join(", ")}`);
					}
					if (result.ignoredUnknown.length > 0) {
						parts.push(`Ignored unknown: ${result.ignoredUnknown.join(", ")}`);
					}
					break;
				}
				case "reset": {
					const activated = listing.filter((r) => r.active).map((r) => r.name);
					parts.push(`Reset. Active tools now: ${activated.join(", ")}`);
					break;
				}
			}

			const toolResult: AgentToolResult<unknown> = {
				content: [{ type: "text", text: parts.join("\n") }],
				details: {
					action: params.action,
					active: listing.filter((r) => r.active).map((r) => r.name),
					total: listing.length,
					rows: listing,
					// #0003: per-call diff so the TUI can show only what changed in
					// expanded mode for activate/deactivate/reset, instead of the full
					// roster. `list` always reports both arrays empty.
					changed: {
						activated: [...added].sort(),
						deactivated: [...removed].sort(),
					},
					ignoredUnknown: result.ignoredUnknown,
					ignoredProtected: result.ignoredProtected,
				},
			};

			// Always hint the loop to terminate so that when manage_tools is
			// alone in its tool batch the run ends early and the auto-continue
			// can build a fresh snapshot. When batched with other tools the loop
			// only honors `terminate` if EVERY member of the batch sets it, so
			// this is silently ignored — and the agent_end listener fires at the
			// natural end of the run instead.
			// Previously only set when tools were activated; now set for every
			// manage_tools call (list, activate, deactivate, reset) so the LLM
			// always gets a fresh turn to act on the result.
			toolResult.terminate = true;

			return Promise.resolve(toolResult);
		},
	});
}

export { computeNext, type Action, type ComputeInputs, type ComputeResult } from "./manager.js";
