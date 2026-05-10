/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only read-only tools are available.
 *
 * Features:
 * - /plan command, Ctrl+Alt+P, or Shift+Tab to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Switches to model/thinking-level from ~/.pi/agent/pi-plan-mode.json while active;
 *   restores the previous model and thinking level when disabled.
 */

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import {
	buildPlanModeContextMessage,
	filterContextMessages,
	shouldBlockBashInPlan,
} from "./handlers.js";
import {
	loadPlanModeConfig,
	pickLatestPlanState,
	type PersistedPlanModeState,
	type PlanStateCandidateEntry,
	STATE_CUSTOM_TYPE,
} from "./state.js";
import { ToolSnapshot } from "./tool-snapshot.js";
import { formatToolList } from "./utils.js";

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "ask_user_question"];
// Fallback used when no snapshot exists (e.g. plan mode was restored from a
// previous session and the pre-plan tool set is unknown).
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	const toolSnapshot = new ToolSnapshot();

	// Snapshots of model and thinking level captured when plan mode is enabled.
	// Undefined means either plan mode was never enabled in this session chain,
	// or the persisted snapshot pointed at a model that is no longer available.
	let modelSnapshot: Model<any> | undefined;
	let thinkingLevelSnapshot: ThinkingLevel | undefined;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}
	}

	/**
	 * Apply model + thinking level from the plan-mode config file.
	 * Called both on enable (in-session toggle) and on session_start resume.
	 */
	async function applyPlanModeConfig(ctx: ExtensionContext): Promise<void> {
		const config = loadPlanModeConfig();
		if (config.model) {
			const models = ctx.modelRegistry.getAll();
			const model = config.provider
				? models.find((m) => m.id === config.model && m.provider === config.provider)
				: models.find((m) => m.id === config.model);
			if (model) {
				await pi.setModel(model);
			}
		}
		if (config.thinkingLevel) {
			pi.setThinkingLevel(config.thinkingLevel);
		}
	}

	/**
	 * Disable plan mode: restore tool set, model, and thinking level.
	 * Assumes `planModeEnabled` has already been set to false by the caller.
	 */
	async function disablePlanMode(ctx: ExtensionContext): Promise<void> {
		// No snapshot means plan mode was restored from a previous session —
		// we have no record of what model/thinking/tools were active before.
		const hasSnapshot = modelSnapshot !== undefined || thinkingLevelSnapshot !== undefined || toolSnapshot.hasSaved();
		if (!hasSnapshot) {
			ctx.ui.notify(
				"Plan mode was restored from a previous session — original model, thinking level, and tools could not be restored.",
				"warning",
			);
		}

		// Restore model if we have a snapshot (skipped for session-resumed plan mode).
		if (modelSnapshot !== undefined) {
			await pi.setModel(modelSnapshot);
		}
		if (thinkingLevelSnapshot !== undefined) {
			pi.setThinkingLevel(thinkingLevelSnapshot);
		}
		modelSnapshot = undefined;
		thinkingLevelSnapshot = undefined;

		const restored = toolSnapshot.restore(NORMAL_MODE_TOOLS);
		pi.setActiveTools(restored);
		ctx.ui.notify(`Plan mode disabled. ${formatToolList(restored)}`);
		updateStatus(ctx);
	}

	async function togglePlanMode(ctx: ExtensionContext): Promise<void> {
		planModeEnabled = !planModeEnabled;

		if (planModeEnabled) {
			// Snapshot current model and thinking level before switching.
			modelSnapshot = ctx.model;
			thinkingLevelSnapshot = pi.getThinkingLevel();

			toolSnapshot.save(pi.getActiveTools());
			pi.setActiveTools(PLAN_MODE_TOOLS);
			ctx.ui.notify(`Plan mode enabled. ${formatToolList(PLAN_MODE_TOOLS)}`);
			updateStatus(ctx);

			// Apply plan-mode model/thinking after notifying so the user sees the
			// enable message regardless of whether setModel succeeds.
			await applyPlanModeConfig(ctx);
		} else {
			await disablePlanMode(ctx);
		}
	}

	function persistState(): void {
		const savedTools = toolSnapshot.getSaved();
		const state: PersistedPlanModeState = {
			enabled: planModeEnabled,
			...(modelSnapshot
				? { modelSnapshot: { id: modelSnapshot.id, provider: modelSnapshot.provider } }
				: {}),
			...(thinkingLevelSnapshot !== undefined ? { thinkingLevelSnapshot } : {}),
			...(savedTools !== null ? { toolsSnapshot: savedTools } : {}),
		};
		pi.appendEntry(STATE_CUSTOM_TYPE, state);
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => {
			await togglePlanMode(ctx);
			persistState();
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			await togglePlanMode(ctx);
			persistState();
		},
	});

	// Shift+Tab as a second toggle. Pi core's `app.thinking.cycle` defaults to
	// shift+tab; users who want plan-mode on this key should drop shift+tab
	// from that action in ~/.pi/agent/keybindings.json (leaving any alternate
	// bindings like ctrl+] / ctrl+[ for thinking cycle).
	pi.registerShortcut(Key.shift("tab"), {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			await togglePlanMode(ctx);
			persistState();
		},
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event) => shouldBlockBashInPlan(event, planModeEnabled));

	// Filter out stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		if (planModeEnabled) return;
		return { messages: filterContextMessages(event.messages) };
	});

	// Inject plan-mode context before agent starts
	pi.on("before_agent_start", async () => {
		if (!planModeEnabled) return undefined;
		return { message: buildPlanModeContextMessage() };
	});

	// After the plan is drafted, prompt the user for the next action.
	pi.on("agent_end", async (_event, ctx) => {
		if (!planModeEnabled || !ctx.hasUI) return;

		// Signal to other extensions (e.g. pi-cmux-notifications) that the agent
		// is now blocked waiting for user input at the UI level.
		pi.events.emit("need_user_attention", { source: "plan-mode", title: "Plan mode — what next?" });

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice === "Execute the plan") {
			planModeEnabled = false;
			await disablePlanMode(ctx);
			persistState();
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: "Execute the plan you just created.", display: true },
				{ triggerTurn: true },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim());
			}
		}

		// User has responded — clear the attention state.
		pi.events.emit("user_attention_resolved", { source: "plan-mode" });
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries() as readonly PlanStateCandidateEntry[];
		const picked = pickLatestPlanState(entries);

		if (picked) {
			planModeEnabled = picked.state.enabled ?? planModeEnabled;

			// Only the new format carries snapshots; `pickLatestPlanState` already
			// strips snapshot fields from legacy entries.
			if (planModeEnabled && picked.source === "new") {
				const data = picked.state;
				if (data.thinkingLevelSnapshot) {
					thinkingLevelSnapshot = data.thinkingLevelSnapshot;
				}
				if (data.modelSnapshot) {
					const { id, provider } = data.modelSnapshot;
					const found = ctx.modelRegistry
						.getAll()
						.find((m) => m.id === id && m.provider === provider);
					if (found) {
						modelSnapshot = found;
					}
				}
				if (data.toolsSnapshot && data.toolsSnapshot.length > 0) {
					toolSnapshot.save(data.toolsSnapshot);
				}
			}
		}

		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
			await applyPlanModeConfig(ctx);
		}
		updateStatus(ctx);
	});
}
