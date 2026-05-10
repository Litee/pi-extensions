import { describe, expect, it } from "vitest";

import { buildDiscoverNotifications } from "../src/discoverMessages.js";
import type { DiscoveredSkill } from "../src/types.js";

function mkSkill(qualifiedName: string): DiscoveredSkill {
	const bare = qualifiedName.split("/").pop() ?? qualifiedName;
	const plugin = qualifiedName.includes("/") ? qualifiedName.split("/")[0]! : "@user";
	return {
		qualifiedName,
		skillName: bare,
		pluginId: plugin,
		skillDir: `/fixture/${qualifiedName}`,
		skillFile: `/fixture/${qualifiedName}/SKILL.md`,
	};
}

const STATE = "/home/u/.pi/agent/pi-claude-code-skills-import.json";

describe("buildDiscoverNotifications", () => {
	it("emits a single info summary with '0 loaded' when there are no skills", () => {
		const out = buildDiscoverNotifications({
			all: [],
			disabled: new Set(),
			collisions: new Map(),
			stateFile: STATE,
		});
		expect(out).toEqual([{ text: "Claude Code skills: 0 loaded", level: "info" }]);
	});

	it("emits info summary with enabled count and (N disabled) suffix", () => {
		const out = buildDiscoverNotifications({
			all: [mkSkill("@user/alpha"), mkSkill("@user/beta")],
			disabled: new Set(["@user/alpha"]),
			collisions: new Map(),
			stateFile: STATE,
		});
		expect(out).toHaveLength(1);
		expect(out[0]).toEqual({
			text: "Claude Code skills: 1 loaded (1 disabled)",
			level: "info",
		});
	});

	it("omits the disabled suffix when nothing is disabled", () => {
		const out = buildDiscoverNotifications({
			all: [mkSkill("@user/alpha")],
			disabled: new Set(),
			collisions: new Map(),
			stateFile: STATE,
		});
		expect(out[0]?.text).toBe("Claude Code skills: 1 loaded");
	});

	it("emits a collision warning listing each colliding name and its sources", () => {
		const a = mkSkill("@user/dup");
		const b = mkSkill("plugin@owner/dup");
		const out = buildDiscoverNotifications({
			all: [a, b],
			disabled: new Set(),
			collisions: new Map([["dup", [a, b]]]),
			stateFile: STATE,
		});
		const warning = out.find((n) => n.level === "warning");
		expect(warning).toBeDefined();
		expect(warning!.text).toContain("1 Claude Code skill name collision");
		expect(warning!.text).toContain('"dup"');
		expect(warning!.text).toContain("@user/dup");
		expect(warning!.text).toContain("plugin@owner/dup");
	});

	it("emits the stale-id warning mentioning the state file path and each stale id, sorted", () => {
		const out = buildDiscoverNotifications({
			all: [mkSkill("@user/alpha")],
			disabled: new Set([
				"some-plugin/removed-skill",
				"litee-claude-code-plugins/writing/1.0.5/old-skill",
			]),
			collisions: new Map(),
			stateFile: STATE,
		});
		const stale = out.find(
			(n) => n.level === "warning" && n.text.includes("no longer resolve"),
		);
		expect(stale).toBeDefined();
		const body = stale!.text;
		expect(body).toContain("2 disabled id(s)");
		expect(body).toContain(STATE);
		const lit = body.indexOf("litee-claude-code-plugins/writing/1.0.5/old-skill");
		const other = body.indexOf("some-plugin/removed-skill");
		expect(lit).toBeGreaterThan(-1);
		expect(other).toBeGreaterThan(lit); // sorted ascending
		// multi-line format with bullets
		expect(body.split("\n").length).toBeGreaterThanOrEqual(4);
		expect(body).toMatch(/^\s*• /m);
	});

	it("does NOT emit a stale warning when every disabled id still resolves", () => {
		const out = buildDiscoverNotifications({
			all: [mkSkill("@user/alpha")],
			disabled: new Set(["@user/alpha"]),
			collisions: new Map(),
			stateFile: STATE,
		});
		expect(out.filter((n) => n.level === "warning")).toHaveLength(0);
	});

	it("does NOT emit a stale warning when the disabled set is empty", () => {
		const out = buildDiscoverNotifications({
			all: [mkSkill("@user/alpha")],
			disabled: new Set(),
			collisions: new Map(),
			stateFile: STATE,
		});
		expect(out.filter((n) => n.level === "warning")).toHaveLength(0);
	});

	it("emits info, collision, and stale notifications together in that order", () => {
		const a = mkSkill("@user/dup");
		const b = mkSkill("plugin@owner/dup");
		const out = buildDiscoverNotifications({
			all: [a, b],
			disabled: new Set(["never-installed/skill"]),
			collisions: new Map([["dup", [a, b]]]),
			stateFile: STATE,
		});
		expect(out.map((n) => n.level)).toEqual(["info", "warning", "warning"]);
		expect(out[0]?.text).toContain("loaded");
		expect(out[1]?.text).toContain("collision");
		expect(out[2]?.text).toContain("no longer resolve");
		expect(out[2]?.text).toContain(STATE);
	});
});
