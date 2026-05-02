/** A discovered Claude Code skill. */
export interface DiscoveredSkill {
	/** Fully-qualified name used for sort/display/disable, e.g. "aws-athena/query-athena". */
	qualifiedName: string;
	/** Bare skill name (from SKILL.md frontmatter, else directory basename). */
	skillName: string;
	/** "@user" for ~/.claude/skills, "@project" for <cwd>/.claude/skills, otherwise the plugin name. */
	pluginId: string;
	/** Absolute path to the directory that contains SKILL.md. */
	skillDir: string;
	/** Absolute path to SKILL.md. */
	skillFile: string;
}

/** An entry from `<claudeDir>/plugins/installed_plugins.json`. */
export interface PluginEntry {
	/** Full key from the manifest, e.g. "aws-athena@litee-claude-code-plugins". */
	pluginKey: string;
	/** Bare plugin name (part before the `@`). */
	pluginName: string;
	/** Absolute path on disk where the active plugin version is installed. */
	installPath: string;
}

/** Shape persisted in ~/.pi/claude-plugin-skills.json. */
export interface PersistedState {
	disabled: string[];
}
