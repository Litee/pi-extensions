import { describe, expect, it } from "vitest";

import { buildSettingItems } from "../src/settingItems.js";
import { computeCollisions } from "../src/collisions.js";
import type { DiscoveredSkill } from "../src/types.js";

function skill(skillName: string, pluginId: string): DiscoveredSkill {
	return {
		qualifiedName: `${pluginId}/${skillName}`,
		skillName,
		pluginId,
		skillDir: `/tmp/${pluginId}/${skillName}`,
		skillFile: `/tmp/${pluginId}/${skillName}/SKILL.md`,
	};
}

describe("buildSettingItems", () => {
	it("returns one item per skill with id=qualifiedName and values=['enabled','disabled']", () => {
		const a = skill("a", "@user");
		const b = skill("b", "alpha");
		const items = buildSettingItems([a, b], new Set(), new Map());
		expect(items).toHaveLength(2);
		expect(items[0]!.id).toBe("@user/a");
		expect(items[0]!.values).toEqual(["enabled", "disabled"]);
		expect(items[1]!.id).toBe("alpha/b");
	});

	it("sets currentValue='disabled' iff the skill id is in the disabled set", () => {
		const a = skill("a", "@user");
		const b = skill("b", "@user");
		const items = buildSettingItems([a, b], new Set(["@user/a"]), new Map());
		const byId = Object.fromEntries(items.map((i) => [i.id, i.currentValue]));
		expect(byId).toEqual({ "@user/a": "disabled", "@user/b": "enabled" });
	});

	it("marks items whose skillName is in the collisions map with isCollision=true", () => {
		const a = skill("dup", "@user");
		const b = skill("dup", "alpha");
		const c = skill("solo", "alpha");
		const collisions = computeCollisions([a, b, c]);
		const items = buildSettingItems([a, b, c], new Set(), collisions);
		const byId = Object.fromEntries(items.map((i) => [i.id, i.isCollision]));
		expect(byId).toEqual({
			"@user/dup": true,
			"alpha/dup": true,
			"alpha/solo": false,
		});
	});

	it("preserves input ordering", () => {
		const xs = [skill("z", "@user"), skill("a", "@user"), skill("m", "alpha")];
		const items = buildSettingItems(xs, new Set(), new Map());
		expect(items.map((i) => i.id)).toEqual(["@user/z", "@user/a", "alpha/m"]);
	});

	it("returns [] for empty input", () => {
		expect(buildSettingItems([], new Set(), new Map())).toEqual([]);
	});
});
