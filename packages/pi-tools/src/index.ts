/**
 * pi-tool-info
 *
 * Registers a `/tools` command that lets you review every tool available
 * to pi in the current session: name, source, active/inactive state,
 * description, full JSON parameter schema, and a compact token estimate.
 *
 * Usage:
 *   /tools              → pick a tool from a selector, then view details
 *   /tools <name>       → jump straight to details for <name>
 *   /tools --all        → render details for every tool in one view
 *
 * From the per-tool detail view:
 *   ← (Left arrow)          → back to the selector (when entered from it)
 *   Enter / Esc             → close
 *
 * Security notes
 * --------------
 *   - No network calls, no filesystem writes, no process spawns.
 *   - No dynamic imports, no `eval`, no `Function(...)`.
 *   - APIs touched: `pi.registerCommand`, `pi.getAllTools`, `pi.getActiveTools`
 *     and the `ctx.ui.*` dialog helpers.
 */

import type { ExtensionAPI, ExtensionCommandContext, ToolInfo } from "@mariozechner/pi-coding-agent";
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

/**
 * Render a Markdown body in a modal component.
 *
 * @param canGoBack when true, Left arrow resolves with "back" so the caller
 *                  can re-open the selector; otherwise Left simply closes.
 */
async function showMarkdown(
	title: string,
	body: string,
	ctx: ExtensionCommandContext,
	canGoBack: boolean,
): Promise<CloseReason> {
	if (!ctx.hasUI) {
		ctx.ui.notify(`${title}\n\n${body}`, "info");
		return "done";
	}

	const hint = canGoBack ? "Press ← to go back · Enter or Esc to close" : "Press Enter or Esc to close";

	const result = await ctx.ui.custom<CloseReason>((_tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		const mdTheme = getMarkdownTheme();

		container.addChild(border);
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(new Markdown(body, 1, 1, mdTheme));
		container.addChild(new Text(theme.fg("dim", hint), 1, 0));
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
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
	pi.registerCommand("tools", {
		description: "Show tools with their descriptions and parameter schemas",
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
			const active = new Set(pi.getActiveTools());
			const arg = args.trim();

			const totalTokens = tools.reduce((sum, t) => sum + estimateToolTokens(t), 0);
			const activeTokens = tools
				.filter((t) => active.has(t.name))
				.reduce((sum, t) => sum + estimateToolTokens(t), 0);

			// --all: dump every tool in one markdown view.
			if (ALL_FLAGS.has(arg)) {
				const byName = [...tools].sort((a, b) => a.name.localeCompare(b.name));
				const body = [
					`_${tools.length} tool(s) · ${active.size} active · ~${activeTokens} active tokens (${totalTokens} total)_`,
					"",
					...byName.map((t) => renderToolMarkdown(t, active)),
				].join("\n\n");
				await showMarkdown("All Tools", body, ctx, false);
				return;
			}

			// Named tool: show its details directly.
			if (arg) {
				const tool = tools.find((t) => t.name === arg);
				if (!tool) {
					ctx.ui.notify(`Unknown tool: ${arg}`, "warning");
					return;
				}
				await showMarkdown(`Tool: ${tool.name}`, renderToolMarkdown(tool, active), ctx, false);
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
					`Tools (${tools.length} total, ${active.size} active · ~${activeTokens} tokens)`,
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
				const reason = await showMarkdown(`Tool: ${tool.name}`, renderToolMarkdown(tool, active), ctx, true);
				if (reason === "back") continue;
				return;
			}
		},
	});
}
