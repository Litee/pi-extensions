/**
 * pi-tools
 *
 * Registers a `/tools` command that lets you review every tool available
 * to pi in the current session: name, source, active/inactive state,
 * description, full JSON parameter schema, and a compact token estimate.
 * Tools can also be toggled on/off from the detail view; the selection is
 * persisted to the session and restored on reload or branch navigation.
 *
 * Usage:
 *   /tools              → pick a tool from a selector, then view details
 *   /tools <name>       → jump straight to details for <name>
 *   /tools --all        → render details for every tool in one view
 *
 * From the tool selector list:
 *   t                       → toggle tool enabled/disabled in place
 *   Enter                   → open detail view for the focused tool
 *   Esc                     → close
 *
 * From the per-tool detail view:
 *   t                       → toggle tool enabled/disabled
 *   ← (Left arrow)          → back to the selector (when entered from it)
 *   Enter / Esc             → close
 *
 * This file is intentionally thin: state vars, event wiring, and the
 * `/tools` command glue that drives `ctx.ui.custom`. All pure logic lives
 * in sibling modules and is unit-tested:
 *   - `renderToolMarkdown.ts` — Markdown assembly for the detail view
 *   - `completions.ts`        — argument autocomplete filter + truncation
 *   - `rows.ts`               — selector row layout & grouping
 *   - `branchState.ts`        — saved-tools lookup in the session branch
 *   - `helpers.ts`            — token estimation + title formatting
 *
 * Security notes
 * --------------
 *   - No network calls, no filesystem writes, no process spawns.
 *   - No dynamic imports, no `eval`, no `Function(...)`.
 *   - APIs touched: `pi.registerCommand`, `pi.getAllTools`, `pi.getActiveTools`,
 *     `pi.setActiveTools`, `pi.appendEntry`, `pi.on`, and the `ctx.ui.*` dialog helpers.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme, getSelectListTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, matchesKey, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

import { pickSavedTools, TOOLS_CONFIG_CUSTOM_TYPE, type ToolsState } from "./branchState.js";
import { getToolArgumentCompletions } from "./completions.js";
import { buildSelectorTitle, estimateToolTokens } from "./helpers.js";
import { renderToolMarkdown } from "./renderToolMarkdown.js";
import { buildToolRows, type RowLayout } from "./rows.js";

const ALL_FLAGS = new Set(["--all", "-a", "all", "*"]);

// Total target visible width for a list row. The description tail shrinks to
// fit whatever space is left after the name + token badge. If the terminal is
// narrower, the select component will still clip visually at the right.
const LIST_LAYOUT: RowLayout = { listRowWidth: 100, minDescWidth: 20 };

type CloseReason = "back" | "done";

/** Passed to showMarkdown to enable live in-place toggling. */
interface ToggleInfo {
	tool: ToolInfo;
	/** The live enabledTools set — mutated by onToggle so re-renders see the new state. */
	active: Set<string>;
	onToggle: (name: string) => void;
}

/**
 * Render a Markdown body in a modal component.
 *
 * @param canGoBack  when true, Left arrow resolves with "back" so the caller
 *                   can re-open the selector; otherwise Left simply closes.
 * @param toggleInfo when provided, pressing `t` toggles the tool and
 *                   re-renders the markdown in place without closing the view.
 */
async function showMarkdown(
	title: string,
	body: string,
	ctx: ExtensionCommandContext,
	canGoBack: boolean,
	toggleInfo?: ToggleInfo,
): Promise<CloseReason> {
	if (!ctx.hasUI) {
		ctx.ui.notify(`${title}\n\n${body}`, "info");
		return "done";
	}

	const hintParts = [
		toggleInfo ? "t to toggle" : null,
		canGoBack ? "← to go back" : null,
		"Enter or Esc to close",
	].filter((p): p is string => p !== null);
	const hint = `Press ${hintParts.join(" · ")}`;

	const result = await ctx.ui.custom<CloseReason>((tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		const mdTheme = getMarkdownTheme();
		const md = new Markdown(body, 1, 1, mdTheme);

		container.addChild(border);
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(md);
		container.addChild(new Text(theme.fg("dim", hint), 1, 0));
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (toggleInfo && matchesKey(data, "t")) {
					toggleInfo.onToggle(toggleInfo.tool.name);
					md.setText(renderToolMarkdown(toggleInfo.tool, toggleInfo.active));
					md.invalidate();
					tui.requestRender();
					return;
				}
				if (canGoBack && matchesKey(data, "left")) {
					done("back");
					return;
				}
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
					done("done");
				}
			},
		};
	});

	return result ?? "done";
}

export default function toolInfoExtension(pi: ExtensionAPI) {
	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------

	let enabledTools: Set<string> = new Set<string>();

	function persistState(): void {
		pi.appendEntry<ToolsState>(TOOLS_CONFIG_CUSTOM_TYPE, { enabledTools: [...enabledTools] });
	}

	function applyTools(): void {
		pi.setActiveTools([...enabledTools]);
	}

	function restoreFromBranch(ctx: ExtensionContext): void {
		const allToolNames = new Set(pi.getAllTools().map((t) => t.name));
		const saved = pickSavedTools(ctx.sessionManager.getBranch());
		if (saved) {
			enabledTools = new Set(saved.filter((t) => allToolNames.has(t)));
			applyTools();
		} else {
			enabledTools = new Set(pi.getActiveTools());
		}
	}

	// ---------------------------------------------------------------------------
	// Session event handlers
	// ---------------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	// ---------------------------------------------------------------------------
	// /tools command
	// ---------------------------------------------------------------------------

	pi.registerCommand("tools", {
		description: "Show tools with their descriptions and parameter schemas; press t in a tool view to toggle it",
		getArgumentCompletions: (prefix) => getToolArgumentCompletions(prefix, pi.getAllTools()),
		handler: async (args, ctx) => {
			const tools = pi.getAllTools();
			if (tools.length === 0) {
				ctx.ui.notify("No tools registered", "warning");
				return;
			}

			// Use the live enabledTools set so the selector reflects real-time toggles.
			const active = enabledTools;
			const arg = args.trim();

			const totalTokens = tools.reduce((sum, t) => sum + estimateToolTokens(t), 0);
			const activeTokens = () =>
				tools.filter((t) => active.has(t.name)).reduce((sum, t) => sum + estimateToolTokens(t), 0);

			// --all: dump every tool in one markdown view (read-only, no toggle).
			if (ALL_FLAGS.has(arg)) {
				const byName = [...tools].sort((a, b) => a.name.localeCompare(b.name));
				const body = [
					`_${tools.length} tool(s) · ${active.size} active · ~${activeTokens()} active tokens (${totalTokens} total)_`,
					"",
					...byName.map((t) => renderToolMarkdown(t, active)),
				].join("\n\n");
				await showMarkdown("All Tools", body, ctx, false);
				return;
			}

			// Shared toggle callback reused by both the list and the detail view.
			const onToggle = (name: string): void => {
				if (enabledTools.has(name)) enabledTools.delete(name);
				else enabledTools.add(name);
				applyTools();
				persistState();
			};

			// Named tool: show its details directly (with toggle support).
			if (arg) {
				const tool = tools.find((t) => t.name === arg);
				if (!tool) {
					ctx.ui.notify(`Unknown tool: ${arg}`, "warning");
					return;
				}
				await showMarkdown(`Tool: ${tool.name}`, renderToolMarkdown(tool, active), ctx, false, { tool, active, onToggle });
				return;
			}

			// No args: interactive selector, grouped by source. Repeat until the
			// user dismisses a detail view with Enter/Esc (or cancels the list).
			const theme = ctx.ui.theme;
			const selectListTheme = getSelectListTheme();

			const buildRowsWithActions = () => {
				const rows = buildToolRows(tools, active, theme, LIST_LAYOUT);
				rows.push({ label: theme.fg("dim", "── actions ──") });
				rows.push({
					label: `${theme.fg("accent", "»")}  ${theme.bold("show all tools in one view")}`,
					toolName: "__ALL__",
				});
				return rows;
			};

			while (true) {
				// Show the interactive selector. Pressing `t` toggles the focused tool
				// in-place; Enter selects it; Esc cancels.
				const selectedToolName = (await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
					let savedIndex = 0;

					const buildList = (): SelectList => {
						const freshRows = buildRowsWithActions();
						const freshItems: SelectItem[] = freshRows.map((r) => ({
							value: r.toolName ?? "__header__",
							label: r.label,
						}));
						const sl = new SelectList(
							freshItems,
							Math.min(freshItems.length + 2, 20),
							selectListTheme,
						);
						sl.onSelect = (item) => {
							// Group headers are inert — stay in the list.
							if (item.value === "__header__") return;
							done(item.value);
						};
						sl.onCancel = () => done(null);
						sl.onSelectionChange = (item) => {
							savedIndex = freshItems.findIndex((i) => i.value === item.value);
						};
						return sl;
					};

					let selectList = buildList();

					return {
						render: (w) => {
							const title = buildSelectorTitle(tools.length, active.size, activeTokens(), totalTokens);
							return [
								theme.bold(title),
								"",
								...selectList.render(w),
								theme.fg("dim", " t to toggle · Enter to view details · Esc to close"),
							];
						},
						invalidate: () => selectList.invalidate(),
						handleInput: (data) => {
							if (matchesKey(data, "t")) {
								const item = selectList.getSelectedItem();
								if (item?.value && item.value !== "__header__" && item.value !== "__ALL__") {
									onToggle(item.value);
									selectList = buildList();
									selectList.setSelectedIndex(savedIndex);
								}
								tui.requestRender();
								return;
							}
							selectList.handleInput(data);
							tui.requestRender();
						},
					};
				})) ?? null;

				if (selectedToolName === null) return; // user cancelled

				if (selectedToolName === "__ALL__") {
					const byName = [...tools].sort((a, b) => a.name.localeCompare(b.name));
					const body = byName.map((t) => renderToolMarkdown(t, active)).join("\n\n");
					const reason = await showMarkdown("All Tools", body, ctx, true);
					if (reason === "back") continue;
					return;
				}

				const tool = tools.find((t) => t.name === selectedToolName);
				if (!tool) continue;

				const reason = await showMarkdown(
					`Tool: ${tool.name}`,
					renderToolMarkdown(tool, active),
					ctx,
					true,
					{ tool, active, onToggle },
				);
				if (reason === "back") continue;
				return;
			}
		},
	});
}
