import { beforeEach, describe, expect, it, vi } from "vitest";

// We mock execFile and platform so no real processes are spawned
vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
	spawn: vi.fn(),
}));

vi.mock("node:os", () => ({
	platform: vi.fn(),
}));

import { execFile } from "node:child_process";
import { platform } from "node:os";
import { detectPlatform, playAudioFile } from "../src/audio.js";

const mockExecFile = vi.mocked(execFile);
const mockPlatform = vi.mocked(platform);

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

function mockExecSuccess() {
	mockExecFile.mockImplementation((_cmd, _args, optsOrCb?: unknown, maybeCb?: unknown) => {
		const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as ExecFileCallback | undefined;
		cb?.(null, "", "");
		return {} as ReturnType<typeof execFile>;
	});
}

function mockExecFail(message = "not found") {
	mockExecFile.mockImplementation((_cmd, _args, optsOrCb?: unknown, maybeCb?: unknown) => {
		const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as ExecFileCallback | undefined;
		cb?.(new Error(message), "", "");
		return {} as ReturnType<typeof execFile>;
	});
}

describe("detectPlatform", () => {
	beforeEach(() => vi.resetAllMocks());

	it("returns 'darwin' on macOS", () => {
		mockPlatform.mockReturnValue("darwin");
		expect(detectPlatform()).toBe("darwin");
	});

	it("returns 'linux' on Linux", () => {
		mockPlatform.mockReturnValue("linux");
		expect(detectPlatform()).toBe("linux");
	});

	it("returns 'win32' on Windows", () => {
		mockPlatform.mockReturnValue("win32");
		expect(detectPlatform()).toBe("win32");
	});

	it("throws on unsupported platform", () => {
		mockPlatform.mockReturnValue("freebsd");
		expect(() => detectPlatform()).toThrow(/freebsd/);
	});
});

describe("playAudioFile — darwin", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockPlatform.mockReturnValue("darwin");
	});

	it("calls afplay with the file path", async () => {
		mockExecSuccess();
		await playAudioFile("/tmp/test.wav");

		const afplayCalls = mockExecFile.mock.calls.filter((c) => c[0] === "afplay");
		expect(afplayCalls.length).toBeGreaterThan(0);
		expect(afplayCalls[0]![1]).toContain("/tmp/test.wav");
	});

	it("throws when afplay returns non-zero", async () => {
		mockExecFail("afplay: no such file");
		await expect(playAudioFile("/tmp/test.wav")).rejects.toThrow("afplay: no such file");
	});
});

describe("playAudioFile — linux", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockPlatform.mockReturnValue("linux");
	});

	it("uses paplay when available", async () => {
		// All calls succeed (which includes 'which paplay')
		mockExecSuccess();
		await playAudioFile("/tmp/test.wav");

		const paplayCalls = mockExecFile.mock.calls.filter((c) => c[0] === "paplay");
		expect(paplayCalls.length).toBeGreaterThan(0);
	});

	it("falls back to aplay when paplay is absent", async () => {
		mockExecFile.mockImplementation((_cmd, args, optsOrCb?: unknown, maybeCb?: unknown) => {
			const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as ExecFileCallback | undefined;
			// which paplay → fail
			if (Array.isArray(args) && args[0] === "paplay") {
				cb?.(new Error("not found"), "", "");
			} else {
				// everything else succeeds
				cb?.(null, "", "");
			}
			return {} as ReturnType<typeof execFile>;
		});

		await playAudioFile("/tmp/test.wav");
		const aplayCalls = mockExecFile.mock.calls.filter((c) => c[0] === "aplay");
		expect(aplayCalls.length).toBeGreaterThan(0);
	});

	it("falls back to ffplay when paplay and aplay are absent", async () => {
		mockExecFile.mockImplementation((_cmd, args, optsOrCb?: unknown, maybeCb?: unknown) => {
			const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as ExecFileCallback | undefined;
			if (Array.isArray(args) && (args[0] === "paplay" || args[0] === "aplay")) {
				cb?.(new Error("not found"), "", "");
			} else {
				cb?.(null, "", "");
			}
			return {} as ReturnType<typeof execFile>;
		});

		await playAudioFile("/tmp/test.wav");
		const ffplayCalls = mockExecFile.mock.calls.filter((c) => c[0] === "ffplay");
		expect(ffplayCalls.length).toBeGreaterThan(0);
	});

	it("throws when no audio player is found", async () => {
		mockExecFail("not found");
		await expect(playAudioFile("/tmp/test.wav")).rejects.toThrow(/No audio player found/);
	});
});

describe("playAudioFile — win32", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockPlatform.mockReturnValue("win32");
	});

	it("calls PowerShell SoundPlayer", async () => {
		mockExecSuccess();
		await playAudioFile("C:\\test.wav");

		const psCalls = mockExecFile.mock.calls.filter((c) => c[0] === "powershell");
		expect(psCalls.length).toBeGreaterThan(0);
		const psArgs = psCalls[0]![1] as string[];
		expect(psArgs.join(" ")).toContain("SoundPlayer");
	});
});
