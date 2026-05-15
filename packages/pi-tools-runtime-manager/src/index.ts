/**
 * pi-tools-runtime-manager — Pi extension.
 *
 * Registers a `manage_tools` tool so the LLM can list, activate, deactivate,
 * and reset its own tool set at runtime. Built on top of pi's own runtime
 * tool-management API (`pi.getAllTools` / `pi.getActiveTools` /
 * `pi.setActiveTools`). Changes take effect on the next LLM call.
 *
 * Design decisions:
 *   - `manage_tools` itself is PROTECTED: deactivating it is silently refused
 *     so the LLM can't lock itself out.
 *   - `reset` restores the active set captured at `session_start`. The
 *     snapshot is retaken on every session_start event (new / resume / fork).
 *   - Unknown tool names are silently dropped and reported back in the
 *     result text so the LLM can correct itself.
 *   - No filesystem or network I/O. Only pi APIs are touched.
 */

import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { computeNext } from "./manager.js";

const TOOL_NAME = "manage_tools";
const PROTECTED: ReadonlySet<string> = new Set([TOOL_NAME]);

const DESCRIPTION = `List, activate, deactivate, or reset the tools available to you. Use this to focus your toolbox for a subtask — for example, disable edit/write during pure exploration, or activate a dynamically-registered tool you need.

Actions:
- "list": return every registered tool with its active/inactive state and description. No effect on the tool set.
- "activate": enable one or more tools by name. Idempotent. Unknown names are silently dropped.
- "deactivate": disable one or more tools by name. Idempotent. Protected tools (like manage_tools itself) are silently refused.
- "reset": restore the active set that was in effect at session_start. Useful to undo your own changes after a subtask.

Notes:
- Changes take effect on the NEXT turn, not the current one. If you activate a tool, you cannot call it in the same assistant turn.
- manage_tools can never deactivate itself. You always retain the ability to reset.
- Activate/deactivate accept multiple tool names at once via the "tools" array.`;

const PROMPT_GUIDELINES = [
	"Prefer manage_tools when the user asks to narrow or expand the toolbox, instead of asking them to toggle tools by hand.",
	"manage_tools changes apply on the next turn. Do not call a freshly-activated tool in the same turn.",
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

export default function manageToolsExtension(pi: ExtensionAPI): void {
	let startupActive: Set<string> = new Set();

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
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Manage Tools",
		description: DESCRIPTION,
		promptSnippet:
			"List, activate, deactivate, or reset your own tools at runtime (takes effect next turn).",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ParamsSchema,

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("muted", "..."), 0, 0);

			interface DetailsShape {
				active: string[];
				total: number;
				rows: ListingRow[];
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
			} else {
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

			if (result.nextActive) {
				pi.setActiveTools([...result.nextActive]);
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

			return Promise.resolve({
				content: [{ type: "text", text: parts.join("\n") }],
				details: {
					action: params.action,
					active: listing.filter((r) => r.active).map((r) => r.name),
					total: listing.length,
					rows: listing,
					ignoredUnknown: result.ignoredUnknown,
					ignoredProtected: result.ignoredProtected,
				},
			});
		},
	});
}

export { computeNext, type Action, type ComputeInputs, type ComputeResult } from "./manager.js";
