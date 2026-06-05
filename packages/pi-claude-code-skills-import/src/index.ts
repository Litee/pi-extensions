import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { computeCollisions } from "./collisions.js";
import { buildDiscoverNotifications } from "./discoverMessages.js";
import { discoverAllSkills } from "./discover.js";
import { readDisabled, writeDisabled } from "./persistence.js";
import { resolveClaudeDir } from "./resolve.js";
import { buildSettingItems, type ToggleSettingItem } from "./settingItems.js";
import { applyToggle } from "./toggle.js";
import { makeTuiPicker } from "./tuiPicker.js";
import type { DiscoveredSkill } from "./types.js";

/** Arguments handed to a `/cc-skills-info` picker strategy. */
export interface CcSkillsPickerArgs {
	skills: DiscoveredSkill[];
	disabled: Set<string>;
	items: ToggleSettingItem[];
	collisions: Map<string, DiscoveredSkill[]>;
	/** Invoke to toggle a skill. Updates `disabled` and persists to `stateFile`. */
	onToggle: (id: string, value: "enabled" | "disabled") => void;
}

/** Pluggable picker — real one drives pi-tui; tests pass a stub. */
export type CcSkillsPicker = (args: CcSkillsPickerArgs) => Promise<void>;

export interface HandleCcSkillsOptions {
	ctx: { reload: () => Promise<void> | void };
	claudeDir: string;
	stateFile: string;
	cwd?: string;
	picker: CcSkillsPicker;
	/**
	 * Persist the disabled-skill id set. Defaults to {@link writeDisabled}.
	 * Exposed so tests can inject a spy and so the production wiring can
	 * replace the implementation (e.g. batching, mocking in CI) without
	 * touching the core flow.
	 */
	persist?: (stateFile: string, disabled: Set<string>) => void;
}

/**
 * Core `/cc-skills-info` flow. Factored out of the TUI wiring so the control flow
 * (discover → present → toggle → persist-on-close → reload-if-dirty) is
 * unit-testable without a live TUI runtime.
 *
 * Persistence is **deferred until the picker closes** (issue #0004): a user
 * rapidly toggling N skills inside the TUI triggers exactly one write to the
 * state file, not N. If no net change occurred, no write happens at all.
 */
export async function handleCcSkills(opts: HandleCcSkillsOptions): Promise<void> {
	const skills = discoverAllSkills(
		opts.cwd === undefined
			? { claudeDir: opts.claudeDir, alreadyLoadedSkills: [] }
			: { claudeDir: opts.claudeDir, cwd: opts.cwd, alreadyLoadedSkills: [] },
	);
	const disabled = readDisabled(opts.stateFile);
	const collisions = computeCollisions(skills);
	const items = buildSettingItems(skills, disabled, collisions);
	const persist = opts.persist ?? writeDisabled;

	// Capture initial state as a canonicalised fingerprint so we can skip
	// both the write AND the reload when the picker's net effect is zero
	// (e.g. toggle-off then toggle-on the same skill).
	const initialFingerprint = [...disabled].sort().join("\u0000");

	const onToggle: CcSkillsPickerArgs["onToggle"] = (id, value) => {
		applyToggle(id, value, disabled);
	};

	await opts.picker({ skills, disabled, items, collisions, onToggle });

	const finalFingerprint = [...disabled].sort().join("\u0000");
	if (initialFingerprint !== finalFingerprint) {
		persist(opts.stateFile, disabled);
		await opts.ctx.reload();
	}
}

/** Default location for the persisted disabled-skills state file.
 *
 * Stored directly under `~/.pi/agent/`, next to `settings.json` and other
 * pi-level config. `$PI_CLAUDE_SKILLS_STATE` env var is honored as an override
 * (used by tests and as an escape hatch).
 */
export function defaultStateFile(env: NodeJS.ProcessEnv, home: string): string {
	const override = env["PI_CLAUDE_SKILLS_STATE"];
	if (override !== undefined && override !== "") return override;
	return join(home, ".pi", "agent", "pi-claude-code-skills-import.json");
}

/** Pi extension default export. */
export default function (pi: ExtensionAPI): void {
	pi.on("resources_discover", (event, ctx) => {
		const claudeDir = resolveClaudeDir(process.env, homedir());
		const stateFile = defaultStateFile(process.env, homedir());

		// Require pi 0.78.0+ API — no heuristic fallback.
		const ctxWithOpts = ctx as {
			getSystemPromptOptions?: () => {
				skills?: Array<{ name: string; path: string; content: string }>;
			};
		};
		if (typeof ctxWithOpts.getSystemPromptOptions !== "function") {
			ctx.ui.notify("Skill discovery requires pi 0.78.0 or later", "error");
			return { skillPaths: [] };
		}
		const alreadyLoadedSkills = ctxWithOpts.getSystemPromptOptions().skills ?? [];

		const all = discoverAllSkills({ claudeDir, cwd: event.cwd, alreadyLoadedSkills });
		const disabled = readDisabled(stateFile);
		const collisions = computeCollisions(all);

		for (const n of buildDiscoverNotifications({ all, disabled, collisions, stateFile })) {
			ctx.ui.notify(n.text, n.level);
		}

		const skillPaths = all
			.filter((s) => !disabled.has(s.qualifiedName))
			.map((s) => s.skillDir);
		return { skillPaths };
	});

	pi.registerCommand("cc-skills-info", {
		description: "List & toggle Claude Code skills (global, persistent)",
		handler: async (_args, ctx) => {
			const claudeDir = resolveClaudeDir(process.env, homedir());
			const stateFile = defaultStateFile(process.env, homedir());
			await handleCcSkills({
				ctx,
				claudeDir,
				stateFile,
				cwd: ctx.cwd,
				picker: makeTuiPicker(ctx),
			});
		},
	});
}

export { discoverAllSkills } from "./discover.js";
export { computeCollisions } from "./collisions.js";
export { resolveClaudeDir } from "./resolve.js";
export { buildSettingItems } from "./settingItems.js";
export type { DiscoveredSkill, PluginEntry, PersistedState } from "./types.js";
