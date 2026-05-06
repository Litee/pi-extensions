/**
 * pi-tool-info
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
 * From the per-tool detail view:
 *   t                       → toggle tool enabled/disabled
 *   ← (Left arrow)          → back to the selector (when entered from it)
 *   Enter / Esc             → close
 *
 * Security notes
 * --------------
 *   - No network calls, no filesystem writes, no process spawns.
 *   - No dynamic imports, no `eval`, no `Function(...)`.
 *   - APIs touched: `pi.registerCommand`, `pi.getAllTools`, `pi.getActiveTools`,
 *     `pi.setActiveTools`, `pi.appendEntry`, `pi.on`, and the `ctx.ui.*` dialog helpers.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@mariozechner/pi-tui";

import { estimateToolTokens, formatTokens, sourceLabel, truncate } from "./helpers.js";

const ALL_FLAGS = new Set(["--all", "-a", "all", "*"]);

// Total target visible width for a list row. The description tail shrinks to
// fit whatever space is left after the name + token badge. If the terminal is
// narrower, the select component will still clip visually at the right.
const LIST_ROW_WIDTH = 100;
const MIN_DESC_WIDTH = 20;
const COMPLETION_DESC_WIDTH = 80;

interface ToolsState {
	enabledTools: string[];
}

function renderToolMarkdown(tool: ToolInfo, active: Set<string>): string {
	const status = active.has(tool.name) ? "✅ active" : "⛔ inactive";
	const desc = tool.description?.trim() || "_(no description)_";
	const tokens = estimateToolTokens(tool);
	let schema: string;
	try {
		schema = JSON.stringify(tool.parameters ?? {}, null, 2);
	} catch {
		schema = String(tool.parameters);
	}
	return [
		`## ${tool.name}  ${status}`,
		`**Source:** ${sourceLabel(tool)}  ·  **Tokens:** ~${tokens}`,
		"",
		desc,
		"",
		"**Parameters:**",
		"```json",
		schema,
		"```",
	].join("\n");
}

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
					// Rebuild markdown body with the updated active set (mutated by onToggle).
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

	let enabledTools: Set<string> = new Set(pi.getActiveTools());

	function persistState(): void {
		pi.appendEntry<ToolsState>("tools-config", { enabledTools: [...enabledTools] });
	}

	function applyTools(): void {
		pi.setActiveTools([...enabledTools]);
	}

	function restoreFromBranch(ctx: ExtensionContext): void {
		const allTools = pi.getAllTools();
		const allToolNames = new Set(allTools.map((t) => t.name));

		// Walk branch entries newest-first to find the last saved tools-config.
		const branchEntries = ctx.sessionManager.getBranch();
		let savedTools: string[] | undefined;
		for (const entry of branchEntries) {
			if (entry.type === "custom" && entry.customType === "tools-config") {
				const data = entry.data as ToolsState | undefined;
				if (data?.enabledTools) {
					savedTools = data.enabledTools;
				}
		  }
		}

		if (savedTools) {
			// Filter to only tools that still exist in this session.
			enabledTools = new Set(savedTools.filter((t) => allToolNames.has(t)));
			applyTools();
		} else {
			// No saved state — mirror whatever is currently active.
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
		getArgumentCompletions: (prefix) => {
			const tools = pi.getAllTools();
			const candidates = ["--all", ...tools.map((t) => t.name)];
			const filtered = candidates.filter((c) => c.startsWith(prefix));
			if (filtered.length === 0) return null;
			return filtered.map((value) => {
				const tool = tools.find((t) => t.name === value);
				const first = tool?.description?.split("\n")[0] ?? "";
				return first
					? { value, label: value, description: truncate(first, COMPLETION_DESC_WIDTH) }
					: { value, label: value };
			});
		},
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

			// Named tool: show its details directly (with toggle support).
			if (arg) {
				const tool = tools.find((t) => t.name === arg);
				if (!tool) {
					ctx.ui.notify(`Unknown tool: ${arg}`, "warning");
					return;
				}
				const toggleInfo: ToggleInfo = {
					tool,
					active,
					onToggle: (name) => {
						if (enabledTools.has(name)) enabledTools.delete(name);
						else enabledTools.add(name);
						applyTools();
						persistState();
					},
				};
				await showMarkdown(`Tool: ${tool.name}`, renderToolMarkdown(tool, active), ctx, false, toggleInfo);
				return;
			}

			// No args: interactive selector, grouped by source. Repeat until the
			// user dismisses a detail view with Enter/Esc (or cancels the list).
			const theme = ctx.ui.theme;

			type Row = { label: string; toolName?: string };
			const buildRows = (): Row[] => {
				const grouped = new Map<string, ToolInfo[]>();
				for (const tool of tools) {
					const key = tool.sourceInfo?.source ?? "unknown";
					const list = grouped.get(key) ?? [];
					list.push(tool);
					grouped.set(key, list);
				}
				const sourceOrder = ["builtin", "sdk", "extension", "skill", "unknown"];
				const orderedKeys = [
					...sourceOrder.filter((k) => grouped.has(k)),
					...[...grouped.keys()].filter((k) => !sourceOrder.includes(k)),
				];

				const rows: Row[] = [];
				for (const key of orderedKeys) {
					const list = grouped.get(key)!.sort((a, b) => a.name.localeCompare(b.name));
					rows.push({ label: theme.fg("dim", `── ${key} (${list.length}) ──`) });
					for (const tool of list) {
						const mark = active.has(tool.name) ? theme.fg("accent", "●") : theme.fg("dim", "○");
						// Plain (uncolored) pieces are used to measure visible width;
						// colored/bold versions are used for display.
						const tokenPlain = `[${formatTokens(estimateToolTokens(tool))} tok]`;
						const name = theme.bold(tool.name);
						const tokens = theme.fg("dim", tokenPlain);

						const firstLine = tool.description?.split("\n")[0]?.trim() ?? "";
						let desc = "";
						if (firstLine) {
							// Fixed pieces in visible chars: mark(1) + 2sp + name + 1sp +
							// tokenPlain + " — " (3) + description. Description shrinks to
							// fit LIST_ROW_WIDTH, but never below MIN_DESC_WIDTH.
							const fixed = 1 + 2 + tool.name.length + 1 + tokenPlain.length + 3;
							const budget = Math.max(MIN_DESC_WIDTH, LIST_ROW_WIDTH - fixed);
							desc = ` ${theme.fg("dim", `— ${truncate(firstLine, budget)}`)}`;
						}
						rows.push({ label: `${mark}  ${name} ${tokens}${desc}`, toolName: tool.name });
					}
				}
				rows.push({
					label: theme.fg("dim", "── actions ──"),
				});
				rows.push({
					label: `${theme.fg("accent", "»")}  ${theme.bold("show all tools in one view")}`,
					toolName: "__ALL__",
				});
				return rows;
			};

			while (true) {
				const rows = buildRows();
				const selectedLabel = await ctx.ui.select(
					`Tools (${tools.length} total, ${active.size} active · ~${activeTokens()} tokens)`,
					rows.map((r) => r.label),
				);
				if (!selectedLabel) return; // user cancelled

				const row = rows.find((r) => r.label === selectedLabel);
				if (!row?.toolName) continue; // clicked a group header

				if (row.toolName === "__ALL__") {
					const byName = [...tools].sort((a, b) => a.name.localeCompare(b.name));
					const body = byName.map((t) => renderToolMarkdown(t, active)).join("\n\n");
					const reason = await showMarkdown("All Tools", body, ctx, true);
					if (reason === "back") continue;
					return;
				}

				const tool = tools.find((t) => t.name === row.toolName);
				if (!tool) continue;

				const toggleInfo: ToggleInfo = {
					tool,
					active,
					onToggle: (name) => {
						if (enabledTools.has(name)) enabledTools.delete(name);
						else enabledTools.add(name);
						applyTools();
						persistState();
					},
				};
				const reason = await showMarkdown(
					`Tool: ${tool.name}`,
					renderToolMarkdown(tool, active),
					ctx,
					true,
					toggleInfo,
				);
				if (reason === "back") continue;
				return;
			}
		},
	});
}
