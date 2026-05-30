/**
 * Tests for FakeSandboxProvider — in-process fake that returns canned responses.
 *
 * We call `exec()` directly on the provider (no create() step, no sandcastle).
 * Tests stay fast and self-contained.
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";

import { fake, type FakeResponse } from "../../src/sandbox/fake.js";
import { PI_SW_RESULT_TAG } from "../../src/structuredOutput.js";

const TEST_CWD = tmpdir();

describe("FakeSandboxProvider", () => {
	it("has name 'fake'", () => {
		expect(fake().name).toBe("fake");
	});

	it("sandboxHomedir is undefined", () => {
		expect(fake().sandboxHomedir).toBeUndefined();
	});
});

describe("FakeSandboxProvider — label-keyed routing", () => {
	it("returns the text response registered for the current label", async () => {
		const provider = fake({
			responses: { planner: { kind: "text", stdout: "plan output" } },
		});
		provider.setCurrentLabel("planner");
		const result = await provider.exec({ command: "any-command", cwd: TEST_CWD });
		expect(result.stdout).toBe("plan output");
		expect(result.exitCode).toBe(0);
	});

	it("wraps kind:'object' in the default pi_sw_result tag", async () => {
		const provider = fake({
			responses: {
				reviewer: { kind: "object", value: { verdict: "APPROVED" } },
			},
		});
		provider.setCurrentLabel("reviewer");
		const result = await provider.exec({ command: "cmd", cwd: TEST_CWD });
		expect(result.stdout).toContain(`<${PI_SW_RESULT_TAG}>`);
		expect(result.stdout).toContain(`"verdict": "APPROVED"`);
		expect(result.stdout).toContain(`</${PI_SW_RESULT_TAG}>`);
	});

	it("uses a custom tag from FakeSandboxOptions", async () => {
		const provider = fake({
			responses: { a: { kind: "object", value: 42 } },
			tag: "my_tag",
		});
		provider.setCurrentLabel("a");
		const result = await provider.exec({ command: "cmd", cwd: TEST_CWD });
		expect(result.stdout).toContain("<my_tag>");
		expect(result.stdout).not.toContain(`<${PI_SW_RESULT_TAG}>`);
	});

	it("rejects when strict (default) and label not found", async () => {
		const provider = fake({ responses: {} });
		provider.setCurrentLabel("missing");
		await expect(
			provider.exec({ command: "cmd", cwd: TEST_CWD }),
		).rejects.toThrow(/no response registered for label "missing"/);
	});

	it("returns empty success when strict:false and no response", async () => {
		const provider = fake({ strict: false });
		provider.setCurrentLabel("ghost");
		const result = await provider.exec({ command: "cmd", cwd: TEST_CWD });
		expect(result.stdout).toBe("");
		expect(result.exitCode).toBe(0);
	});
});

describe("FakeSandboxProvider — FIFO fallback", () => {
	it("dequeues FIFO responses in order when no label match", async () => {
		const r1: FakeResponse = { kind: "text", stdout: "first" };
		const r2: FakeResponse = { kind: "text", stdout: "second" };
		const provider = fake({ fifo: [r1, r2] });
		const res1 = await provider.exec({ command: "cmd", cwd: TEST_CWD });
		const res2 = await provider.exec({ command: "cmd", cwd: TEST_CWD });
		expect(res1.stdout).toBe("first");
		expect(res2.stdout).toBe("second");
	});

	it("label takes precedence over FIFO", async () => {
		const provider = fake({
			responses: { lbl: { kind: "text", stdout: "labeled" } },
			fifo: [{ kind: "text", stdout: "fifo" }],
		});
		provider.setCurrentLabel("lbl");
		const result = await provider.exec({ command: "cmd", cwd: TEST_CWD });
		expect(result.stdout).toBe("labeled");
	});

	it("falls through to FIFO when label not found", async () => {
		const provider = fake({
			responses: { other: { kind: "text", stdout: "other" } },
			fifo: [{ kind: "text", stdout: "fifo-value" }],
		});
		provider.setCurrentLabel("unknown");
		const result = await provider.exec({ command: "cmd", cwd: TEST_CWD });
		expect(result.stdout).toBe("fifo-value");
	});
});

describe("FakeSandboxProvider — calls recording", () => {
	it("records every exec call with label, command, cwd, ts", async () => {
		const provider = fake({ fifo: [{ kind: "text", stdout: "" }] });
		provider.setCurrentLabel("step1");
		await provider.exec({ command: "echo hello", cwd: TEST_CWD });
		expect(provider.calls).toHaveLength(1);
		const call = provider.calls[0];
		expect(call?.label).toBe("step1");
		expect(call?.command).toBe("echo hello");
		expect(call?.ts).toBeGreaterThan(0);
	});

	it("records calls in order across multiple execs", async () => {
		const provider = fake({
			fifo: [
				{ kind: "text", stdout: "a" },
				{ kind: "text", stdout: "b" },
			],
		});
		provider.setCurrentLabel("first");
		await provider.exec({ command: "cmd1", cwd: TEST_CWD });
		provider.setCurrentLabel("second");
		await provider.exec({ command: "cmd2", cwd: TEST_CWD });
		expect(provider.calls.map((c) => c.label)).toEqual(["first", "second"]);
		expect(provider.calls.map((c) => c.command)).toEqual(["cmd1", "cmd2"]);
	});
});

describe("FakeSandboxProvider — throw response", () => {
	it("rejects exec when kind:throw response is registered", async () => {
		const err = new Error("simulated crash");
		const provider = fake({
			responses: { crasher: { kind: "throw", error: err } },
		});
		provider.setCurrentLabel("crasher");
		await expect(
			provider.exec({ command: "cmd", cwd: TEST_CWD }),
		).rejects.toThrow("simulated crash");
	});
});

describe("FakeSandboxProvider — runtime mutation", () => {
	it("setResponse adds or replaces a label entry", async () => {
		const provider = fake();
		provider.setResponse("dynamic", { kind: "text", stdout: "dynamic output" });
		provider.setCurrentLabel("dynamic");
		const result = await provider.exec({ command: "cmd", cwd: TEST_CWD });
		expect(result.stdout).toBe("dynamic output");
	});

	it("enqueueResponse appends to the FIFO queue", async () => {
		const provider = fake();
		provider.enqueueResponse({ kind: "text", stdout: "queued" });
		const result = await provider.exec({ command: "cmd", cwd: TEST_CWD });
		expect(result.stdout).toBe("queued");
	});
});

describe("FakeSandboxProvider — onLine streaming", () => {
	it("calls onLine for each line of a text response", async () => {
		const provider = fake({
			fifo: [{ kind: "text", stdout: "line1\nline2\nline3" }],
		});
		const lines: string[] = [];
		await provider.exec({ command: "cmd", cwd: TEST_CWD, onLine: (l) => lines.push(l) });
		expect(lines).toEqual(["line1", "line2", "line3"]);
	});
});
