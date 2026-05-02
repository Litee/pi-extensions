import { describe, expect, it } from "vitest";

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

describe("computeCollisions", () => {
	it("returns an empty map when no names collide", () => {
		const result = computeCollisions([skill("a", "@user"), skill("b", "@user")]);
		expect(result.size).toBe(0);
	});

	it("returns an empty map for an empty input", () => {
		expect(computeCollisions([]).size).toBe(0);
	});

	it("reports a collision when two skills share a name across plugins", () => {
		const a = skill("shared", "@user");
		const b = skill("shared", "alpha");
		const result = computeCollisions([a, b]);
		expect(result.size).toBe(1);
		expect(result.get("shared")).toEqual([a, b]);
	});

	it("does not report names that appear only once", () => {
		const a = skill("shared", "@user");
		const b = skill("shared", "alpha");
		const c = skill("unique", "alpha");
		const result = computeCollisions([a, b, c]);
		expect([...result.keys()].sort()).toEqual(["shared"]);
	});

	it("groups 3+ colliding skills under the same key", () => {
		const xs = [skill("n", "@user"), skill("n", "a"), skill("n", "b")];
		const result = computeCollisions(xs);
		expect(result.get("n")).toEqual(xs);
	});
});
