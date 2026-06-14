/**
 * pi-system-prompt-browser
 *
 * Registers a `/system-prompt-browser` slash command that opens an
 * interactive TUI showing the system prompt broken down by source
 * with token estimates.
 *
 * Two-level menu:
 *   Level 1 (menu) — "System prompt options" | "View full system prompt" | "Close"
 *   Level 2 (details) — formatted breakdown of skills, context files,
 *                       selected tools, appended prompt, guidelines
 *   Level 3 (full prompt) — raw system prompt text as sent to the LLM
 *
 * Keybindings:
 *   ↑ / ↓    Navigate menu
 *   Enter    Select menu item
 *   Esc      Go back to menu / close
 */

import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	estimateTokensFromFile,
	estimateTokensFromContent,
	formatDetailsView,
	formatTokens,
	type SkillWithTokens,
	type ContextFileWithTokens,
} from "./spkbLogic.js";

// ---------------------------------------------------------------------------
// TUI factory — pure closure over pre-read data
// ---------------------------------------------------------------------------

function buildTUIFactory(
	skills: Array<{ name: string; filePath?: string; description?: string }>,
	contextFiles: Array<{ path: string }>,
	selectedTools: string[],
	appendSystemPrompt: string | undefined,
	promptGuidelines: string[] | undefined,
	systemPrompt: string,
) {
	// Estimate skill tokens from description (what's actually loaded into the system prompt)
	const skillEntries: SkillWithTokens[] = skills.map((s) => {
		const tokens = estimateTokensFromContent(s.description ?? "");
		return { name: s.name, filePath: s.filePath ?? "", tokens, error: false };
	});

	// Pre-read context files for token estimation
	const contextEntries: ContextFileWithTokens[] = contextFiles.map((f) => {
		const { tokens, error } = estimateTokensFromFile(f.path);
		return { path: f.path, tokens, error };
	});

	// Build options object, only including optional properties when defined
	const detailsOpts: {
		skills: SkillWithTokens[];
		contextFiles: ContextFileWithTokens[];
		selectedTools: string[];
		appendSystemPrompt?: string;
		promptGuidelines?: string[];
	} = {
		skills: skillEntries,
		contextFiles: contextEntries,
		selectedTools,
	};
	if (appendSystemPrompt !== undefined) {
		detailsOpts.appendSystemPrompt = appendSystemPrompt;
	}
	if (promptGuidelines !== undefined) {
		detailsOpts.promptGuidelines = promptGuidelines;
	}

	const detailsText = formatDetailsView(detailsOpts);

	type View = "menu" | "details" | "fullPrompt";

	let view: View = "menu";
	let selectedIndex = 0;
	const fullPromptLines = systemPrompt.split("\n");

	const menuItems = [
		{ value: "details" as const, label: "System prompt options" },
		{ value: "fullPrompt" as const, label: "View full system prompt" },
		{ value: "close" as const, label: "Close" },
	];

	return (tui: unknown, theme: unknown, _kb: unknown, done: (result: string | null) => void) => {
		const castTheme = theme as { fg: (color: string, text: string) => string; bold: (text: string) => string };

		function renderMenu(width: number): string[] {
			const hr = castTheme.fg("accent", "─".repeat(width));
			const lines: string[] = [
				truncateToWidth(castTheme.fg("accent", castTheme.bold("System Prompt Knowledge Browser")), width),
				hr,
				"",
			];
			for (let i = 0; i < menuItems.length; i++) {
				const item = menuItems[i]!;
				const isSelected = i === selectedIndex;
				const prefix = isSelected ? "→ " : "  ";
				const prefixWidth = visibleWidth(prefix);
				const available = width - prefixWidth;
				const label = isSelected
					? castTheme.fg("accent", item.label)
					: castTheme.fg("dim", item.label);
				lines.push(prefix + truncateToWidth(label, available));
			}
			lines.push("");
			lines.push(truncateToWidth(castTheme.fg("dim", "↑↓ navigate · Enter to select · Esc to close"), width));
			return lines;
		}

		function renderDetails(width: number): string[] {
			const hr = castTheme.fg("accent", "─".repeat(width));
			const detailLines = detailsText
				.split("\n")
				.map((l) => (l ? `  ${l}` : ""));
			const lines: string[] = [
				truncateToWidth(castTheme.fg("accent", castTheme.bold("System Prompt Options")), width),
				hr,
				"",
				...detailLines.map((l) => truncateToWidth(l, width)),
				"",
				truncateToWidth(castTheme.fg("dim", "Esc to go back · Esc to close"), width),
			];
			return lines;
		}

		function renderFullPrompt(width: number): string[] {
			const hr = castTheme.fg("accent", "─".repeat(width));
			const totalTokens = estimateTokensFromContent(fullPromptLines.join("\n"));
			const lines: string[] = [
				truncateToWidth(castTheme.fg("accent", castTheme.bold("Full System Prompt")), width),
				hr,
				"",
				truncateToWidth(castTheme.fg("dim", `~${formatTokens(totalTokens)} tokens`), width),
				"",
			];
			for (const line of fullPromptLines) {
				lines.push(truncateToWidth(line, width));
			}
			lines.push("");
			lines.push(truncateToWidth(castTheme.fg("dim", "Esc to go back · Esc to close"), width));
			return lines;
		}

		return {
			render: (width: number) => {
				if (view === "menu") {
					return renderMenu(width);
				}
				if (view === "fullPrompt") {
					return renderFullPrompt(width);
				}
				return renderDetails(width);
			},
			invalidate: () => {
				// No cached state to invalidate
			},
			handleInput: (data: string) => {
				if (view === "menu") {
					void theme;
					if (matchesKey(data, "up")) {
						selectedIndex = Math.max(0, selectedIndex - 1);
					} else if (matchesKey(data, "down")) {
						selectedIndex = Math.min(menuItems.length - 1, selectedIndex + 1);
					} else if (matchesKey(data, "enter")) {
						const selected = menuItems[selectedIndex]!;
						if (selected.value === "details") {
							view = "details";
						} else if (selected.value === "fullPrompt") {
							view = "fullPrompt";
						} else {
							done(null); // close
							return;
						}
					} else if (matchesKey(data, "escape")) {
						done(null);
						return;
					}
					(tui as { requestRender: () => void }).requestRender();
				} else {
					// details or fullPrompt view: Esc goes back to menu
					if (matchesKey(data, "escape")) {
						view = "menu";
						selectedIndex = 0;
						(tui as { requestRender: () => void }).requestRender();
					}
				}
			},
		};
	};
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function systemPromptBrowserExtension(pi: ExtensionAPI): void {
	pi.registerCommand("system-prompt-browser", {
		description:
			"Interactive system prompt knowledge browser — view sources and token estimates",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					"System prompt knowledge browser requires an interactive terminal",
					"warning",
				);
				return;
			}

			// getSystemPromptOptions is a newer API (pi 0.78.0+)
			const ctxWithOpts = ctx as ExtensionCommandContext & {
				getSystemPromptOptions?(): BuildSystemPromptOptions;
			};
			if (typeof ctxWithOpts.getSystemPromptOptions !== "function") {
				ctx.ui.notify(
					"This command requires pi 0.78.0 or later",
					"error",
				);
				return;
			}

			const opts = ctxWithOpts.getSystemPromptOptions();
			const skills = opts.skills ?? [];
			const contextFiles = opts.contextFiles ?? [];
			const selectedTools = opts.selectedTools ?? [];
			const appendSystemPrompt = opts.appendSystemPrompt;
			const promptGuidelines = opts.promptGuidelines;

			const systemPrompt = ctx.getSystemPrompt();

			await ctx.ui.custom<string | null>(
				buildTUIFactory(
					skills,
					contextFiles,
					selectedTools,
					appendSystemPrompt,
					promptGuidelines,
					systemPrompt,
				),
			);
		},
	});
}
