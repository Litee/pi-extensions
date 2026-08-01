import { describe, expect, it, vi } from "vitest";

import { copyTextToClipboard, getClipboardCommands, runClipboardCommand, type ClipboardCommand } from "../src/clipboard.js";

describe("clipboard helper", () => {
	it("uses pbcopy on macOS", () => {
		expect(getClipboardCommands("darwin")).toEqual([{ command: "pbcopy", args: [] }]);
	});

	it("uses clip on Windows", () => {
		expect(getClipboardCommands("win32")).toEqual([{ command: "clip", args: [] }]);
	});

	it("tries common Linux clipboard commands", () => {
		expect(getClipboardCommands("linux").map((command) => command.command)).toEqual([
			"wl-copy",
			"xclip",
			"xsel",
			"termux-clipboard-set",
		]);
	});

	it("stops after the first successful clipboard command", async () => {
		const commands: ClipboardCommand[] = [
			{ command: "first", args: [] },
			{ command: "second", args: [] },
			{ command: "third", args: [] },
		];
		const runner = vi.fn((command: ClipboardCommand) => Promise.resolve(command.command === "second"));

		await expect(copyTextToClipboard("text", runner, commands)).resolves.toBe(true);
		expect(runner.mock.calls.map(([command]) => command.command)).toEqual(["first", "second"]);
	});

	it("returns false when all clipboard commands fail", async () => {
		const commands: ClipboardCommand[] = [
			{ command: "first", args: [] },
			{ command: "second", args: [] },
		];
		const runner = vi.fn(() => Promise.resolve(false));

		await expect(copyTextToClipboard("text", runner, commands)).resolves.toBe(false);
		expect(runner).toHaveBeenCalledTimes(2);
	});

	describe("runClipboardCommand", () => {
		it("resolves false on child error", async () => {
			const result = await runClipboardCommand({ command: "nonexistent-binary-xyz", args: [] }, "text");
			expect(result).toBe(false);
		});

		it("resolves false on timeout", async () => {
			const mockSpawn = vi.fn(() => ({
				stdio: { pipe: vi.fn() },
				on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
					if (event === "error") cb(new Error("spawn ENOENT"));
				}),
				stdin: { on: vi.fn(), end: vi.fn() },
				kill: vi.fn(),
			}));

			vi.doMock("node:child_process", () => ({ spawn: mockSpawn }));
			const { runClipboardCommand: runCmd } = await import("../src/clipboard.js");

			const result = await runCmd({ command: "test", args: [] }, "text");
			expect(result).toBe(false);

			vi.doUnmock("node:child_process");
		});
	});
});
