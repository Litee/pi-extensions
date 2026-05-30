/**
 * Tests for the pure `mergeChildEnv` helper.
 *
 * These exercise the AWS credential conflict resolution that prevents
 * `claude-code exited with code 1` triggered by the AWS SDK's
 * "Multiple credential sources detected" stderr warning.
 */
import { describe, expect, it } from "vitest";

import { mergeChildEnv } from "../src/sandbox/srt-env.js";

describe("mergeChildEnv", () => {
	it("returns the child unchanged when parent is empty", () => {
		expect(
			mergeChildEnv({}, { FOO: "1", AWS_ACCESS_KEY_ID: "k" }),
		).toEqual({ FOO: "1", AWS_ACCESS_KEY_ID: "k" });
	});

	it("inherits parent env when child is empty", () => {
		expect(mergeChildEnv({ PATH: "/usr/bin", USER: "me" }, {})).toEqual({
			PATH: "/usr/bin",
			USER: "me",
		});
	});

	it("child overrides parent on key collision", () => {
		expect(
			mergeChildEnv({ PATH: "/usr/bin" }, { PATH: "/sandbox/bin" }),
		).toEqual({ PATH: "/sandbox/bin" });
	});

	it("skips parent keys whose value is undefined (NodeJS.ProcessEnv allows undefined)", () => {
		const parent: NodeJS.ProcessEnv = { PATH: "/usr/bin", USER: undefined };
		const out = mergeChildEnv(parent, {});
		expect(out).toEqual({ PATH: "/usr/bin" });
		// Make sure USER is not present at all (not just falsy)
		expect("USER" in out).toBe(false);
	});

	it("strips AWS_PROFILE from parent when child sets AWS_ACCESS_KEY_ID (the bug fix)", () => {
		const out = mergeChildEnv(
			{ AWS_PROFILE: "dev-ai", PATH: "/usr/bin" },
			{ AWS_ACCESS_KEY_ID: "AKIA...", AWS_SECRET_ACCESS_KEY: "s" },
		);
		expect(out["AWS_PROFILE"]).toBeUndefined();
		expect(out["AWS_ACCESS_KEY_ID"]).toBe("AKIA...");
		expect(out["AWS_SECRET_ACCESS_KEY"]).toBe("s");
		// Non-AWS keys must still flow through.
		expect(out["PATH"]).toBe("/usr/bin");
	});

	it("strips AWS_DEFAULT_PROFILE too (alternate profile env var)", () => {
		const out = mergeChildEnv(
			{ AWS_DEFAULT_PROFILE: "dev-ai" },
			{ AWS_ACCESS_KEY_ID: "k" },
		);
		expect(out["AWS_DEFAULT_PROFILE"]).toBeUndefined();
	});

	it("preserves parent AWS_PROFILE when child does NOT set AWS_ACCESS_KEY_ID", () => {
		// This is the workflow-opts-into-profile-auth case. Don't strip
		// what the parent intentionally set.
		const out = mergeChildEnv(
			{ AWS_PROFILE: "dev-ai" },
			{ AWS_REGION: "us-west-2" },
		);
		expect(out["AWS_PROFILE"]).toBe("dev-ai");
		expect(out["AWS_REGION"]).toBe("us-west-2");
	});

	it("does not mutate the parent or child arguments", () => {
		const parent = { AWS_PROFILE: "dev-ai", PATH: "/usr/bin" };
		const child = { AWS_ACCESS_KEY_ID: "k" };
		const before = { parent: { ...parent }, child: { ...child } };
		mergeChildEnv(parent, child);
		expect(parent).toEqual(before.parent);
		expect(child).toEqual(before.child);
	});
});
