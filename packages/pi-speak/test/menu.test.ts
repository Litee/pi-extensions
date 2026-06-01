import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dirSize, modelInfo, nearestPresetLabel, runSpeakMenu, SPEED_PRESETS, STEPS_PRESETS } from "../src/menu.js";
import { VOICES } from "../src/schema.js";
import type { MenuCtx, MenuOptions } from "../src/menu.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drives ctx.ui.select by returning items from `sequence` in order. */
function makeCtxSelect(sequence: (string | null)[]): {
	ctx: MenuCtx;
	selectCalls: string[][];
	notifyCalls: Array<[string, (string | undefined)?]>;
} {
	let i = 0;
	const selectCalls: string[][] = [];
	const notifyCalls: Array<[string, (string | undefined)?]> = [];
	const ctx: MenuCtx = {
		ui: {
			select: vi.fn((_title: string, items: string[]) => {
				selectCalls.push(items);
				return Promise.resolve(sequence[i++] ?? null);
			}),
			notify: vi.fn((msg: string, level?: string) => {
				notifyCalls.push([msg, level]);
			}),
		},
	};
	return { ctx, selectCalls, notifyCalls };
}

/** Non-existent path — modelInfo returns "not downloaded" for this. */
const MISSING_DIR = "/pi-speak-test-assets-nonexistent-12345";

function makeDefaultOptions(overrides: Partial<MenuOptions> = {}): MenuOptions {
	return {
		enabled: false,
		sessionVoice: undefined,
		sessionLang: undefined,
		sessionSpeed: undefined,
		sessionSteps: undefined,
		getAssetsDir: () => MISSING_DIR,
		assetsReady: vi.fn(() => false),
		loadConfig: vi.fn(() => ({})),
		saveConfig: vi.fn(() => true),
		onToggle: vi.fn(() => Promise.resolve(false)),
		onTest: vi.fn(() => Promise.resolve()),
		onSetSessionVoice: vi.fn(),
		onSetSessionLang: vi.fn(),
		onSetSessionSpeed: vi.fn(),
		onSetSessionSteps: vi.fn(),
		onSpeakHello: vi.fn(() => Promise.resolve()),
		getQueueLength: () => 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runSpeakMenu", () => {
	// 1. Selecting "Close" exits the loop
	it("exits when Close is selected", async () => {
		const { ctx, selectCalls } = makeCtxSelect(["Close"]);
		await runSpeakMenu(ctx, makeDefaultOptions());
		expect(selectCalls).toHaveLength(1);
	});

	// 2. Separator line is a no-op — loop continues
	it("ignores separator lines and continues the loop", async () => {
		const { ctx, selectCalls } = makeCtxSelect(["─────────────────────────────", "Close"]);
		await runSpeakMenu(ctx, makeDefaultOptions());
		// Two select calls: separator (no-op) then Close
		expect(selectCalls).toHaveLength(2);
	});

	// 3. Toggle disabled + assets ready → onToggle called, menu re-renders with "enabled"
	it("toggle when disabled + assets ready: calls onToggle, re-renders with 'speak: enabled'", async () => {
		const { ctx, selectCalls } = makeCtxSelect(["speak: disabled", "Close"]);
		const onToggle = vi.fn(() => Promise.resolve(true));
		await runSpeakMenu(ctx, makeDefaultOptions({ onToggle }));
		expect(onToggle).toHaveBeenCalledOnce();
		// Second render should show the enabled state
		expect(selectCalls[1]).toContain("speak: enabled");
	});

	// 4. Toggle disabled + assets missing → onToggle called, menu stays open
	it("toggle when disabled + assets missing: onToggle called, menu stays open", async () => {
		const { ctx, selectCalls } = makeCtxSelect(["speak: disabled", "Close"]);
		const onToggle = vi.fn(() => Promise.resolve(false)); // returns false = still disabled
		await runSpeakMenu(ctx, makeDefaultOptions({ onToggle }));
		expect(onToggle).toHaveBeenCalledOnce();
		// Loop continued → second select call happened
		expect(selectCalls).toHaveLength(2);
	});

	// 5. Toggle when enabled → onToggle called → disables
	it("toggle when enabled: onToggle called, re-renders with 'speak: disabled'", async () => {
		const { ctx, selectCalls } = makeCtxSelect(["speak: enabled", "Close"]);
		const onToggle = vi.fn(() => Promise.resolve(false));
		await runSpeakMenu(ctx, makeDefaultOptions({ enabled: true, onToggle }));
		expect(onToggle).toHaveBeenCalledOnce();
		expect(selectCalls[1]).toContain("speak: disabled");
	});

	// 6. "Test speech" → onTest called
	it("'Test speech' calls onTest", async () => {
		const { ctx } = makeCtxSelect(["Test speech", "Close"]);
		const onTest = vi.fn(() => Promise.resolve());
		await runSpeakMenu(ctx, makeDefaultOptions({ onTest }));
		expect(onTest).toHaveBeenCalledOnce();
	});

	// 7. "Voice: M1" → voice picker → pick "F2" → onSetSessionVoice("F2")
	it("session voice picker: selecting F2 calls onSetSessionVoice('F2')", async () => {
		// Sequence: main menu → "Voice: M1", voice picker → "F2", main menu → "Close"
		const { ctx } = makeCtxSelect(["Voice: M1", "F2", "Close"]);
		const onSetSessionVoice = vi.fn();
		await runSpeakMenu(ctx, makeDefaultOptions({ onSetSessionVoice }));
		expect(onSetSessionVoice).toHaveBeenCalledWith("F2");
	});

	// 8. "Default voice: M1" → voice picker → pick "F1" → saveConfig called
	it("default voice picker: selecting F1 calls saveConfig({ defaultVoice: 'F1' })", async () => {
		const { ctx } = makeCtxSelect(["Default voice: M1", "F1", "Close"]);
		const saveConfig = vi.fn(() => true);
		await runSpeakMenu(ctx, makeDefaultOptions({ saveConfig }));
		expect(saveConfig).toHaveBeenCalledWith({ defaultVoice: "F1" });
	});

	// 9. Voice picker "Cancel" → onSetSessionVoice NOT called
	it("voice picker Cancel: onSetSessionVoice not called", async () => {
		const { ctx } = makeCtxSelect(["Voice: M1", "Cancel", "Close"]);
		const onSetSessionVoice = vi.fn();
		await runSpeakMenu(ctx, makeDefaultOptions({ onSetSessionVoice }));
		expect(onSetSessionVoice).not.toHaveBeenCalled();
	});

	// 10. Model line shows "not downloaded" when assetsDir does not exist
	it("model info shows 'not downloaded' when assets dir is missing", async () => {
		const { ctx, selectCalls } = makeCtxSelect(["Close"]);
		await runSpeakMenu(ctx, makeDefaultOptions({ getAssetsDir: () => MISSING_DIR }));
		const items = selectCalls[0] ?? [];
		const modelItem = items.find((item) => item.startsWith("Model:"));
		expect(modelItem).toBe("Model: not downloaded");
	});

	// Voice picker items include all 10 voices
	it("voice picker presents all VOICES plus Cancel", async () => {
		const { ctx, selectCalls } = makeCtxSelect(["Voice: M1", null /* cancel */, "Close"]);
		await runSpeakMenu(ctx, makeDefaultOptions());
		// selectCalls[1] is the voice picker
		const voiceItems = selectCalls[1] ?? [];
		for (const v of VOICES) {
			expect(voiceItems).toContain(v);
		}
		expect(voiceItems).toContain("Cancel");
	});

	// 12. Speed picker: selecting "Fast (1.3)" calls onSetSessionSpeed(1.3) and onSpeakHello
	it("speed picker: selecting 'Fast (1.3)' calls onSetSessionSpeed(1.3) and onSpeakHello", async () => {
		const { ctx } = makeCtxSelect(["Speed: Normal (1.05)", "Fast (1.3)", "Close"]);
		const onSetSessionSpeed = vi.fn();
		const onSpeakHello = vi.fn(() => Promise.resolve());
		await runSpeakMenu(ctx, makeDefaultOptions({ onSetSessionSpeed, onSpeakHello }));
		expect(onSetSessionSpeed).toHaveBeenCalledWith(1.3);
		expect(onSpeakHello).toHaveBeenCalled();
	});

	// 13. Steps picker: selecting "Quality — 16 steps" calls onSetSessionSteps(16)
	it("steps picker: selecting 'Quality — 16 steps' calls onSetSessionSteps(16)", async () => {
		const { ctx } = makeCtxSelect(["Steps: Default — 8 steps", "Quality — 16 steps", "Close"]);
		const onSetSessionSteps = vi.fn();
		await runSpeakMenu(ctx, makeDefaultOptions({ onSetSessionSteps }));
		expect(onSetSessionSteps).toHaveBeenCalledWith(16);
	});

	// 14. Language picker: selecting "fr" calls onSetSessionLang("fr")
	it("language picker: selecting 'fr' calls onSetSessionLang('fr')", async () => {
		const { ctx } = makeCtxSelect(["Language: en", "fr", "Close"]);
		const onSetSessionLang = vi.fn();
		await runSpeakMenu(ctx, makeDefaultOptions({ onSetSessionLang }));
		expect(onSetSessionLang).toHaveBeenCalledWith("fr");
	});

	// 15. Default speed: selecting "Slow (0.8)" calls saveConfig({ defaultSpeed: 0.8 })
	it("default speed picker: selecting 'Slow (0.8)' calls saveConfig({ defaultSpeed: 0.8 })", async () => {
		const { ctx } = makeCtxSelect(["Default speed: Normal (1.05)", "Slow (0.8)", "Close"]);
		const saveConfig = vi.fn(() => true);
		await runSpeakMenu(ctx, makeDefaultOptions({ saveConfig }));
		expect(saveConfig).toHaveBeenCalledWith({ defaultSpeed: 0.8 });
	});

	// 16. Queue display item appears when getQueueLength > 0, is non-selectable
	it("shows 'Queue: N items pending' when queue has items", async () => {
		const { ctx, selectCalls } = makeCtxSelect(["Close"]);
		await runSpeakMenu(ctx, makeDefaultOptions({ getQueueLength: () => 2 }));
		const items = selectCalls[0] ?? [];
		expect(items).toContain("Queue: 2 items pending");
	});

	it("shows 'Queue: 1 item pending' (singular) when queue has 1 item", async () => {
		const { ctx, selectCalls } = makeCtxSelect(["Close"]);
		await runSpeakMenu(ctx, makeDefaultOptions({ getQueueLength: () => 1 }));
		const items = selectCalls[0] ?? [];
		expect(items).toContain("Queue: 1 item pending");
	});

	it("does not show queue item when queue is empty", async () => {
		const { ctx, selectCalls } = makeCtxSelect(["Close"]);
		await runSpeakMenu(ctx, makeDefaultOptions({ getQueueLength: () => 0 }));
		const items = selectCalls[0] ?? [];
		expect(items.some((i) => i.startsWith("Queue:"))).toBe(false);
	});

	it("selecting the Queue display item is a no-op (loop continues)", async () => {
		// Sequence: queue item (no-op), then Close
		const { ctx, selectCalls } = makeCtxSelect(["Queue: 2 items pending", "Close"]);
		await runSpeakMenu(ctx, makeDefaultOptions({ getQueueLength: () => 2 }));
		expect(selectCalls).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// 17. nearestPresetLabel
// ---------------------------------------------------------------------------

describe("nearestPresetLabel", () => {
	it("returns the exact label for an exact preset value", () => {
		expect(nearestPresetLabel(SPEED_PRESETS, 1.05)).toBe("Normal (1.05)");
		expect(nearestPresetLabel(STEPS_PRESETS, 8)).toBe("Default — 8 steps");
	});

	it("returns the nearest label for an approximate value", () => {
		// 1.2 is closer to 1.3 than to 1.05
		expect(nearestPresetLabel(SPEED_PRESETS, 1.2)).toBe("Fast (1.3)");
		// 0.9 is closer to 0.8 than to 1.05
		expect(nearestPresetLabel(SPEED_PRESETS, 0.9)).toBe("Slow (0.8)");
	});

	it("handles single-element presets", () => {
		const single = [{ label: "Only", value: 5 }];
		expect(nearestPresetLabel(single, 999)).toBe("Only");
	});
});

// ---------------------------------------------------------------------------
// 11. modelInfo + dirSize with a real temp dir
// ---------------------------------------------------------------------------

describe("modelInfo", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `pi-speak-menu-test-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(() => {
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	it("returns 'not downloaded' for a non-existent path", () => {
		expect(modelInfo("/this-path-surely-does-not-exist-pi-speak")).toBe("Model: not downloaded");
	});

	it("returns size in MB for a real directory", () => {
		// Write ~1 KB of data
		writeFileSync(join(tmpDir, "file.bin"), Buffer.alloc(1024, 0x42));
		const result = modelInfo(tmpDir);
		expect(result).toMatch(/^Model: .+\(\d+ MB\)$/);
	});

	it("dirSize sums nested files", () => {
		const sub = join(tmpDir, "sub");
		mkdirSync(sub);
		writeFileSync(join(tmpDir, "a.bin"), Buffer.alloc(100));
		writeFileSync(join(sub, "b.bin"), Buffer.alloc(200));
		expect(dirSize(tmpDir)).toBe(300);
	});
});
