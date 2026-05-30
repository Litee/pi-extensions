/**
 * Tests for host.createSandbox — credentials and domain behaviour.
 *
 * New design: createSandbox does NOT inject static Bedrock credentials.
 * Pi sub-agents inherit AWS_PROFILE from the parent env and read ~/.aws/
 * directly. Injecting static keys caused the AWS SDK "Multiple credential
 * sources" warning because the pi wrapper always re-sets AWS_PROFILE.
 *
 * What createSandbox DOES do:
 *   - Whitelists bedrock-runtime.<region>.amazonaws.com + sts.amazonaws.com
 *   - Merges caller-supplied allowedDomains
 *   - Passes caller-supplied env through unchanged (no merging with Bedrock env)
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { srtSpy, noSandboxStub, fakeStub } = vi.hoisted(() => {
	const provider = { __test_provider__: true } as unknown;
	return {
		srtSpy: vi.fn(() => provider),
		noSandboxStub: vi.fn(() => provider),
		fakeStub: vi.fn(() => provider),
	};
});

vi.mock("../src/sandbox/index.js", () => ({
	srt: srtSpy,
	noSandbox: noSandboxStub,
	fake: fakeStub,
}));

import { buildWorkflowHost } from "../src/host.js";

function baseOpts(extra: Record<string, unknown> = {}) {
	return {
		name: "test",
		args: "",
		cwd: "/cwd",
		runId: "run-1",
		signal: new AbortController().signal,
		sendMessage: vi.fn(),
		...extra,
	};
}

describe("host.createSandbox — domain allowlist and env passthrough", () => {
	beforeEach(() => {
		srtSpy.mockClear();
	});

	it("does NOT inject static AWS credentials", () => {
		const host = buildWorkflowHost(baseOpts());
		host.createSandbox({ worktreeReadonly: false });

		const calls = srtSpy.mock.calls as unknown as Array<[{ env?: Record<string, string> } | undefined]>;
		const args = calls[0]?.[0];
		// env should be absent (not passed) — no static key injection
		expect(args?.env).toBeUndefined();
		expect(args?.env?.["AWS_ACCESS_KEY_ID"]).toBeUndefined();
	});

	it("whitelists Bedrock runtime domain for the active region", () => {
		process.env["AWS_REGION"] = "us-east-1";
		const host = buildWorkflowHost(baseOpts());
		host.createSandbox();

		const calls = srtSpy.mock.calls as unknown as Array<[Record<string, unknown> | undefined]>;
		const args = calls[0]?.[0] ?? {};
		const domains = args["allowedDomains"] as string[];
		expect(domains).toContain("bedrock-runtime.us-east-1.amazonaws.com");
		expect(domains).toContain("sts.amazonaws.com");
	});

	it("merges caller-supplied allowedDomains with Bedrock domains", () => {
		const host = buildWorkflowHost(baseOpts());
		host.createSandbox({ allowedDomains: ["example.com"] });

		const calls = srtSpy.mock.calls as unknown as Array<[Record<string, unknown> | undefined]>;
		const args = calls[0]?.[0] ?? {};
		const domains = args["allowedDomains"] as string[];
		expect(domains).toContain("example.com");
		expect(domains.some((d: string) => d.includes("amazonaws.com"))).toBe(true);
	});

	it("passes caller-supplied env through unchanged", () => {
		const host = buildWorkflowHost(baseOpts());
		host.createSandbox({ env: { MY_VAR: "hello" } });

		const calls = srtSpy.mock.calls as unknown as Array<[{ env?: Record<string, string> } | undefined]>;
		const args = calls[0]?.[0];
		expect(args?.env).toEqual({ MY_VAR: "hello" });
	});

	it("preserves other srt opts (worktreeReadonly, extraAllowWrite)", () => {
		const host = buildWorkflowHost(baseOpts());
		host.createSandbox({
			worktreeReadonly: false,
			extraAllowWrite: ["/tmp/foo"],
		});

		const calls = srtSpy.mock.calls as unknown as Array<[Record<string, unknown> | undefined]>;
		const args = calls[0]?.[0] ?? {};
		expect(args["worktreeReadonly"]).toBe(false);
		expect(args["extraAllowWrite"]).toEqual(["/tmp/foo"]);
	});
});
