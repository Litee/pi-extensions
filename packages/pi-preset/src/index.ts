/**
 * Preset Extension
 *
 * Named presets that configure model, thinking level, tools, system-prompt
 * instructions, bash command filtering, and post-agent-end action prompts.
 * Presets are defined in JSON config files and activated via CLI flag,
 * /preset command, or Ctrl+Shift+U to cycle.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/presets.json  — global
 * - <cwd>/.pi/presets.json    — project-local
 *
 * Usage:
 * - `pi --preset plan`       start with the "plan" preset
 * - `/preset`                open the interactive selector
 * - `/preset implement`      switch directly to "implement"
 * - `Ctrl+Shift+U`           cycle through all presets + (none)
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Key, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

import { BashFilter } from "./bash-filter.js";
import { loadPresets } from "./config.js";
import { ToolSnapshot } from "./tool-snapshot.js";
import type { OnCompleteAction, Preset, PresetsConfig, ThinkingLevel } from "./types.js";
import { formatToolList } from "./utils.js";

/** customType tag used for injected preset instructions messages. */
const PRESET_CONTEXT_TYPE = "preset-context";

/** Fallback tool set applied when clearing a preset with no saved snapshot. */
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

interface OriginalState {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	tools: string[];
}

export default function presetExtension(pi: ExtensionAPI): void {
	let presets: PresetsConfig = {};
	let activePresetName: string | undefined;
	let activePreset: Preset | undefined;
	let activeBashFilter: BashFilter | undefined;
	let originalState: OriginalState | undefined;
	const toolSnapshot = new ToolSnapshot();

	// ─── CLI flag ──────────────────────────────────────────────────────────────

	pi.registerFlag("preset", {
		description: "Preset configuration to use on startup",
		type: "string",
	});

	// ─── Apply / clear ─────────────────────────────────────────────────────────

	async function applyPreset(name: string, preset: Preset, ctx: ExtensionContext): Promise<void> {
		// Snapshot the pre-preset state only on the first transition from none.
		if (activePresetName === undefined) {
			originalState = {
				model: (ctx as unknown as { model?: Model<Api> }).model,
				thinkingLevel: pi.getThinkingLevel(),
				tools: pi.getActiveTools(),
			};
			toolSnapshot.save(pi.getActiveTools());
		}

		// Apply model if both provider and model are specified.
		if (preset.provider && preset.model) {
			const registry = (ctx as unknown as { modelRegistry?: { find: (p: string, m: string) => Model<Api> | undefined } }).modelRegistry;
			const model = registry?.find(preset.provider, preset.model);
			if (model) {
				const success = await pi.setModel(model);
				if (!success) {
					ctx.ui.notify(`Preset "${name}": no API key for ${preset.provider}/${preset.model}`, "warning");
				}
			} else {
				ctx.ui.notify(`Preset "${name}": model ${preset.provider}/${preset.model} not found`, "warning");
			}
		}

		// Apply thinking level.
		if (preset.thinkingLevel) {
			pi.setThinkingLevel(preset.thinkingLevel);
		}

		// Apply tools — warn on unknowns but still apply the valid subset.
		if (preset.tools && preset.tools.length > 0) {
			const allToolNames = (pi.getAllTools() as Array<{ name: string }>).map((t) => t.name);
			const validTools = preset.tools.filter((t) => allToolNames.includes(t));
			const invalidTools = preset.tools.filter((t) => !allToolNames.includes(t));

			if (invalidTools.length > 0) {
				ctx.ui.notify(`Preset "${name}": unknown tools: ${invalidTools.join(", ")}`, "warning");
			}
			if (validTools.length > 0) {
				pi.setActiveTools(validTools);
			}
		}

		// Build bash filter for this preset.
		activeBashFilter = new BashFilter(preset);

		activePresetName = name;
		activePreset = preset;
	}

	async function clearPreset(ctx: ExtensionContext): Promise<void> {
		activePresetName = undefined;
		activePreset = undefined;
		activeBashFilter = undefined;

		// Restore model and thinking level from pre-preset snapshot.
		if (originalState) {
			if (originalState.model) await pi.setModel(originalState.model);
			pi.setThinkingLevel(originalState.thinkingLevel);
			originalState = undefined;
		}

		// Restore tool set (falls back to NORMAL_MODE_TOOLS on session resume).
		pi.setActiveTools(toolSnapshot.restore(NORMAL_MODE_TOOLS));

		ctx.ui.notify(`Preset cleared. ${formatToolList(pi.getActiveTools())}`);
		updateStatus(ctx);
	}

	// ─── Status pill ───────────────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext): void {
		if (activePresetName) {
			ctx.ui.setStatus("preset", ctx.ui.theme.fg("warning", `preset:${activePresetName}`));
		} else {
			ctx.ui.setStatus("preset", undefined);
		}
	}

	// ─── Selector UI ───────────────────────────────────────────────────────────

	function buildPresetDescription(preset: Preset): string {
		const parts: string[] = [];
		if (preset.provider && preset.model) parts.push(`${preset.provider}/${preset.model}`);
		if (preset.thinkingLevel) parts.push(`thinking:${preset.thinkingLevel}`);
		if (preset.tools) parts.push(`tools:${preset.tools.join(",")}`);
		if (preset.bashAllowlist || preset.bashBlocklist) parts.push("bash-filter");
		if (preset.onComplete?.length) parts.push(`onComplete:${preset.onComplete.length}`);
		if (preset.instructions) {
			const truncated =
				preset.instructions.length > 30 ? `${preset.instructions.slice(0, 27)}...` : preset.instructions;
			parts.push(`"${truncated}"`);
		}
		return parts.join(" | ");
	}

	async function showPresetSelector(ctx: ExtensionContext): Promise<void> {
		const presetNames = Object.keys(presets);
		if (presetNames.length === 0) {
			ctx.ui.notify(
				"No presets defined. Add presets to ~/.pi/agent/presets.json or .pi/presets.json",
				"warning",
			);
			return;
		}

		const items: SelectItem[] = presetNames.map((name) => {
			const preset = presets[name]!;
			const isActive = name === activePresetName;
			return {
				value: name,
				label: isActive ? `${name} (active)` : name,
				description: buildPresetDescription(preset),
			};
		});

		items.push({
			value: "(none)",
			label: activePresetName === undefined ? "(none) (active)" : "(none)",
			description: "Clear active preset, restore defaults",
		});

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Select Preset"))));

			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!result) return;

		if (result === "(none)") {
			await clearPreset(ctx);
			return;
		}

		const preset = presets[result];
		if (preset) {
			await applyPreset(result, preset, ctx);
			ctx.ui.notify(`Preset "${result}" activated. ${formatToolList(pi.getActiveTools())}`);
			updateStatus(ctx);
		}
	}

	// ─── Cycling ───────────────────────────────────────────────────────────────

	async function cyclePreset(ctx: ExtensionContext): Promise<void> {
		const presetNames = Object.keys(presets).sort();
		if (presetNames.length === 0) {
			ctx.ui.notify(
				"No presets defined. Add presets to ~/.pi/agent/presets.json or .pi/presets.json",
				"warning",
			);
			return;
		}

		const cycleList = ["(none)", ...presetNames];
		const currentName = activePresetName ?? "(none)";
		const currentIndex = cycleList.indexOf(currentName);
		const nextName = cycleList[(currentIndex + 1) % cycleList.length]!;

		if (nextName === "(none)") {
			await clearPreset(ctx);
			return;
		}

		const preset = presets[nextName];
		if (!preset) return;

		await applyPreset(nextName, preset, ctx);
		ctx.ui.notify(`Preset "${nextName}" activated. ${formatToolList(pi.getActiveTools())}`);
		updateStatus(ctx);
	}

	// ─── Persistence ───────────────────────────────────────────────────────────

	function persistState(): void {
		pi.appendEntry("preset-state", { name: activePresetName ?? null });
	}

	// ─── Registrations ─────────────────────────────────────────────────────────

	pi.registerShortcut(Key.ctrlShift("u"), {
		description: "Cycle presets",
		handler: async (ctx) => {
			await cyclePreset(ctx);
			persistState();
		},
	});

	// Shift+Tab mirrors pi-plan-mode's binding. Users who want this should remove
	// shift+tab from app.thinking.cycle in ~/.pi/agent/keybindings.json.
	pi.registerShortcut(Key.shift("tab"), {
		description: "Cycle presets",
		handler: async (ctx) => {
			await cyclePreset(ctx);
			persistState();
		},
	});

	pi.registerCommand("preset", {
		description: "Switch preset configuration (/preset [name])",
		handler: async (args, ctx) => {
			const name = args?.trim();
			if (name) {
				const preset = presets[name];
				if (!preset) {
					const available = Object.keys(presets).join(", ") || "(none defined)";
					ctx.ui.notify(`Unknown preset "${name}". Available: ${available}`, "error");
					return;
				}
				await applyPreset(name, preset, ctx);
				ctx.ui.notify(`Preset "${name}" activated. ${formatToolList(pi.getActiveTools())}`);
				updateStatus(ctx);
				persistState();
				return;
			}
			await showPresetSelector(ctx);
		},
	});

	// ─── Event handlers ────────────────────────────────────────────────────────

	// Block disallowed bash commands when the active preset defines filter rules.
	pi.on("tool_call", async (event) => {
		if (!activeBashFilter?.hasRules || event.toolName !== "bash") return;
		const command = (event.input as { command: string }).command;
		if (!activeBashFilter.isSafe(command)) {
			return {
				block: true,
				reason: `Preset "${activePresetName}": bash command blocked by preset rules.\nCommand: ${command}\nUse /preset to switch or clear the active preset.`,
			};
		}
		return undefined;
	});

	// Strip stale preset-context messages from history on every turn so the
	// current preset's instructions (re-injected by before_agent_start) are
	// always the authoritative copy.
	pi.on("context", async (event) => {
		const filtered = (event.messages as Array<AgentMessage & { customType?: string }>).filter(
			(m) => m.customType !== PRESET_CONTEXT_TYPE,
		);
		if (filtered.length === event.messages.length) return;
		return { messages: filtered };
	});

	// Inject preset instructions as a hidden message before each agent turn.
	pi.on("before_agent_start", async () => {
		if (!activePreset?.instructions) return undefined;
		return {
			message: {
				customType: PRESET_CONTEXT_TYPE,
				content: activePreset.instructions,
				display: false,
			},
		};
	});

	// Show the post-turn action prompt when the preset defines onComplete actions.
	pi.on("agent_end", async (_event, ctx) => {
		if (!activePreset?.onComplete?.length || !ctx.hasUI) return;

		const labels = activePreset.onComplete.map((a: OnCompleteAction) => a.label);
		const choice = await ctx.ui.select(`Preset "${activePresetName}" — what next?`, labels);
		const action = activePreset.onComplete.find((a: OnCompleteAction) => a.label === choice);
		if (!action) return;

		// Switch preset first so the subsequent message runs under the new preset.
		// If switchTo is absent, advance to the next preset in the cycle (same as
		// Ctrl+Shift+U), which for a single-preset setup means clearing to (none).
		if (action.switchTo !== undefined) {
			const nextPreset = presets[action.switchTo];
			if (nextPreset) {
				await applyPreset(action.switchTo, nextPreset, ctx);
				ctx.ui.notify(
					`Switched to preset "${action.switchTo}". ${formatToolList(pi.getActiveTools())}`,
				);
				updateStatus(ctx);
				persistState();
			} else {
				ctx.ui.notify(`Preset "${action.switchTo}" not found`, "warning");
			}
		} else {
			// No explicit switchTo — advance to next in cycle.
			await cyclePreset(ctx);
			persistState();
		}

		if (action.sendMessage) {
			pi.sendMessage(
				{ customType: "preset-action", content: action.sendMessage, display: true },
				{ triggerTurn: true },
			);
		} else if (action.promptUser) {
			const refinement = await ctx.ui.editor(`${activePresetName ?? "Preset"} — refine:`, "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim());
			}
		}
	});

	// Restore state on session start / resume.
	pi.on("session_start", async (_event, ctx) => {
		presets = loadPresets(ctx.cwd);

		const presetFlag = pi.getFlag("preset");
		if (typeof presetFlag === "string" && presetFlag) {
			const preset = presets[presetFlag];
			if (preset) {
				await applyPreset(presetFlag, preset, ctx);
				ctx.ui.notify(`Preset "${presetFlag}" activated. ${formatToolList(pi.getActiveTools())}`);
			} else {
				const available = Object.keys(presets).join(", ") || "(none defined)";
				ctx.ui.notify(`Unknown preset "${presetFlag}". Available: ${available}`, "warning");
			}
			updateStatus(ctx);
			return;
		}

		// Restore preset name from session log (instructions only — model/tools
		// are not re-applied on resume to avoid clobbering manual changes).
		const entries = ctx.sessionManager.getEntries();
		const presetEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "preset-state",
			)
			.pop() as { data?: { name: string | null } } | undefined;

		if (presetEntry?.data?.name) {
			const preset = presets[presetEntry.data.name];
			if (preset) {
				activePresetName = presetEntry.data.name;
				activePreset = preset;
				activeBashFilter = new BashFilter(preset);
			}
		}

		updateStatus(ctx);
	});

	// Persist the active preset name before each turn.
	pi.on("turn_start", async () => {
		persistState();
	});
}
