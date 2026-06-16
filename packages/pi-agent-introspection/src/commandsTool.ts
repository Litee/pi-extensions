/**
 * inspect_commands tool
 *
 * Lists all registered slash commands available in the current session,
 * with their names and descriptions.
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Pure formatting helper (extracted for testability)
// ---------------------------------------------------------------------------

/**
 * Pure function: formats a list of slash commands as a readable text summary.
 */
export function formatCommands(commands: SlashCommandInfo[]): string {
	const lines: string[] = [];

	lines.push("## Registered Slash Commands");
	lines.push("");
	lines.push(`**Total:** ${commands.length} command${commands.length === 1 ? "" : "s"}`);
	lines.push("");

	if (commands.length === 0) {
		lines.push("(no commands registered)");
	} else {
		for (const cmd of commands) {
			const description = cmd.description ?? "(no description)";
			lines.push(`- **/${cmd.name}** — ${description}`);
		}
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerCommandsTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "inspect_commands",
		label: "Inspect Commands",
		description:
			"List all registered slash commands available in the current session, with their names and descriptions. " +
			"Useful for investigating what commands extensions have registered.",
		promptSnippet: "inspect_commands: list all registered slash commands and their descriptions",
		parameters: Type.Object({}),
		execute(
			_toolCallId: string,
			_params: Record<string, never>,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<{ commands: string }>> {
			const commands = pi.getCommands();
			const text = formatCommands(commands);

			return Promise.resolve({
				content: [{ type: "text", text }],
				details: { commands: text },
			});
		},
	});
}
