/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only read-only tools are available.
 *
 * Features:
 * - /plan command, Ctrl+Alt+P, or Shift+Tab to toggle
 * - Bash restricted to allowlisted read-only commands
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { ToolSnapshot } from "./tool-snapshot.js";
import { formatToolList, isSafeCommand } from "./utils.js";

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "ask_user_question"];
// Fallback used when no snapshot exists (e.g. plan mode was restored from a
// previous session and the pre-plan tool set is unknown).
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	const toolSnapshot = new ToolSnapshot();

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

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;

		if (planModeEnabled) {
			toolSnapshot.save(pi.getActiveTools());
			pi.setActiveTools(PLAN_MODE_TOOLS);
			ctx.ui.notify(`Plan mode enabled. ${formatToolList(PLAN_MODE_TOOLS)}`);
		} else {
			const restored = toolSnapshot.restore(NORMAL_MODE_TOOLS);
			pi.setActiveTools(restored);
			ctx.ui.notify(`Plan mode disabled. ${formatToolList(restored)}`);
		}
		updateStatus(ctx);
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", { enabled: planModeEnabled });
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => {
			togglePlanMode(ctx);
			persistState();
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			togglePlanMode(ctx);
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
			togglePlanMode(ctx);
			persistState();
		},
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
		return undefined;
	});

	// Filter out stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan-mode context before agent starts
	pi.on("before_agent_start", async () => {
		if (!planModeEnabled) return undefined;
		return {
			message: {
				customType: "plan-mode-context",
				content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls, ask_user_question
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the ask_user_question tool.
Use brave-search skill via bash for web research.

Describe the plan as a numbered list under a "Plan:" header.
Do NOT attempt to make changes - just describe what you would do.`,
				display: false,
			},
		};
	});

	// After the plan is drafted, prompt the user for the next action.
	pi.on("agent_end", async (_event, ctx) => {
		if (!planModeEnabled || !ctx.hasUI) return;

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice === "Execute the plan") {
			planModeEnabled = false;
			pi.setActiveTools(toolSnapshot.restore(NORMAL_MODE_TOOLS));
			updateStatus(ctx);
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
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: { enabled: boolean } } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
		}

		if (planModeEnabled) {
			// On session start/resume the pre-plan tool set is unknown, so we
			// skip saving — restore() will fall back to NORMAL_MODE_TOOLS.
			pi.setActiveTools(PLAN_MODE_TOOLS);
		}
		updateStatus(ctx);
	});
}
