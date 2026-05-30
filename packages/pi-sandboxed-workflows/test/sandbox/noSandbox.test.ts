/**
 * Tests for noSandbox — a provider that exec's directly on the host.
 *
 * We call `exec()` directly on the provider (no create() step, no sandcastle).
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";

import { noSandbox } from "../../src/sandbox/noSandbox.js";

describe("noSandbox provider", () => {
	it("has name 'noSandbox'", () => {
		expect(noSandbox().name).toBe("noSandbox");
	});

	it("sandboxHomedir is undefined", () => {
		expect(noSandbox().sandboxHomedir).toBeUndefined();
	});

	it("exec: runs a string command via sh -c and returns stdout", async () => {
		const provider = noSandbox();
		const result = await provider.exec({ command: "echo hello", cwd: tmpdir() });
		expect(result.stdout.trim()).toBe("hello");
		expect(result.exitCode).toBe(0);
	});

	it("exec: runs an array command without shell", async () => {
		const provider = noSandbox();
		const result = await provider.exec({
			command: ["echo", "hello"],
			cwd: tmpdir(),
		});
		expect(result.stdout.trim()).toBe("hello");
		expect(result.exitCode).toBe(0);
	});

	it("exec: returns non-zero exit code on failure", async () => {
		const provider = noSandbox();
		const result = await provider.exec({ command: "exit 42", cwd: tmpdir() });
		expect(result.exitCode).toBe(42);
	});

	it("exec: streams lines via onLine callback", async () => {
		const lines: string[] = [];
		const provider = noSandbox();
		await provider.exec({
			command: "printf 'a\\nb\\nc'",
			cwd: tmpdir(),
			onLine: (l) => lines.push(l),
		});
		expect(lines).toEqual(["a", "b", "c"]);
	});

	it("exec: injects provider env into the subprocess", async () => {
		const provider = noSandbox({ env: { MY_TEST_VAR: "pi_sw_test_42" } });
		const result = await provider.exec({
			command: "echo $MY_TEST_VAR",
			cwd: tmpdir(),
		});
		expect(result.stdout.trim()).toBe("pi_sw_test_42");
	});

	it("exec: uses cwd from opts when provided", async () => {
		const provider = noSandbox();
		const result = await provider.exec({
			command: "pwd",
			cwd: tmpdir(),
		});
		expect(result.stdout.trim().length).toBeGreaterThan(0);
	});

	it("exec: passes stdin to the subprocess", async () => {
		const provider = noSandbox();
		const result = await provider.exec({
			command: "cat",
			cwd: tmpdir(),
			stdin: "hello stdin",
		});
		expect(result.stdout.trim()).toBe("hello stdin");
	});
});
