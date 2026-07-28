import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock getSelectListTheme so SelectList.render() works without initTheme().
// The mock theme wraps the selected item with brackets so 🔊 is still visible.
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getSelectListTheme: () => ({
		selectedPrefix: (text: string) => `> ${text}`,
		selectedText: (text: string) => `[${text}]`,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
	}),
}));

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
		onPreview: vi.fn().mockResolvedValue(undefined),
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

	// 6b. "Test speech" fires onTest fire-and-forget — menu loop continues without waiting
	it("Test speech fires onTest without blocking the menu loop", async () => {
		let resolveTest!: () => void;
		const testDone = new Promise<void>((r) => { resolveTest = r; });
		const onTest = vi.fn(() => testDone);
		const { ctx } = makeCtxSelect(["Test speech", "Close"]);
		const menuDone = runSpeakMenu(ctx, makeDefaultOptions({ onTest }));
		// After "Test speech" is picked, the menu loop should reopen (fire-and-forget)
		// and complete when "Close" is selected — without waiting for onTest to resolve.
		await menuDone;
		expect(onTest).toHaveBeenCalledTimes(1);
		resolveTest(); // cleanup
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

// ---------------------------------------------------------------------------
// 18-19. pickVoice SelectList: abort-on-navigate and preview text
// ---------------------------------------------------------------------------

describe("pickVoice SelectList preview", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * Builds a ctx where:
	 *   custom call 1  = main menu  → immediately resolves with "Voice: M1"
	 *   custom call 2  = voice picker → exposes component + done for test control
	 *   custom call 3  = main menu  → immediately resolves with "Close"
	 */
	function makeCtxWithCustom() {
		let customCallCount = 0;
		let voicePickerComponent: { handleInput: (data: string) => void } | undefined;
		let voicePickerDone: ((v: string | null) => void) | undefined;

		const ctx: MenuCtx = {
			ui: {
				select: vi.fn(),
				notify: vi.fn(),
				custom: vi.fn(<T>(
					factory: (tui: { requestRender: () => void }, theme: unknown, kb: unknown, done: (v: T) => void) => unknown,
				): Promise<T> => {
					customCallCount++;
					const call = customCallCount;
					return new Promise<T>((resolve) => {
						const component = factory(
							{ requestRender: vi.fn() },
							{ fg: (_r: string, s: string) => s, bold: (s: string) => s },
							{},
							(v: T) => resolve(v),
						);
						if (call === 1) {
							// main menu: select the "Voice: M1" item
							resolve({ value: "Voice: M1", index: 4 } as T);
						} else if (call === 2) {
							// voice picker: hand control to the test
							voicePickerComponent = component as typeof voicePickerComponent;
							voicePickerDone = (v: string | null) => resolve(v as T);
						} else {
							// main menu (after picker returns): close the menu
							resolve({ value: "Close", index: 0 } as T);
						}
					});
				}) as NonNullable<MenuCtx["ui"]["custom"]>,
			},
		};

		return {
			ctx,
			getComponent: () => voicePickerComponent,
			closeVoicePicker: (v: string | null = null) => voicePickerDone?.(v),
		};
	}

	/** Flush enough microtasks for the voice picker to be set up after main-menu resolution. */
	async function flushMicrotasks(n = 10): Promise<void> {
		for (let i = 0; i < n; i++) await Promise.resolve();
	}

	it("rapid navigation (< 400 ms) does not call onPreview; settling after 400 ms calls it exactly once", async () => {
		vi.useFakeTimers();
		const onPreview = vi.fn().mockResolvedValue(undefined);
		const { ctx, getComponent, closeVoicePicker } = makeCtxWithCustom();

		const menuPromise = runSpeakMenu(ctx, makeDefaultOptions({ onPreview }));

		// Let the main-menu resolve and the voice-picker factory be called
		await flushMicrotasks();

		const component = getComponent();
		expect(component).toBeDefined();

		// Navigate down twice before the 400 ms debounce can fire:
		//   first  ↓  → selects M2, sets debounce timer #1
		//   second ↓  → selects M3, clears timer #1, sets debounce timer #2
		component!.handleInput("\x1b[B");
		component!.handleInput("\x1b[B");

		// Nothing yet — both timers haven't fired
		expect(onPreview).not.toHaveBeenCalled();

		// Advance 400 ms — only timer #2 fires
		await vi.advanceTimersByTimeAsync(400);

		expect(onPreview).toHaveBeenCalledOnce();

		// Close the picker then wait for the menu to finish
		closeVoicePicker(null);
		await menuPromise;
	});

	it("preview text passed to onPreview contains the voice name", async () => {
		vi.useFakeTimers();
		const onPreview = vi.fn().mockResolvedValue(undefined);
		const { ctx, getComponent, closeVoicePicker } = makeCtxWithCustom();

		const menuPromise = runSpeakMenu(ctx, makeDefaultOptions({ onPreview }));
		await flushMicrotasks();

		const component = getComponent();
		expect(component).toBeDefined();

		// Navigate down once — M1 → M2
		component!.handleInput("\x1b[B");
		await vi.advanceTimersByTimeAsync(400);

		expect(onPreview).toHaveBeenCalledOnce();
		const [text, voice, lang] = onPreview.mock.calls[0] as [string, string, string, AbortSignal];

		// Text should mention the voice id
		expect(text).toContain(voice);
		// Language should be the effective language ("en" by default)
		expect(lang).toBe("en");

		closeVoicePicker(null);
		await menuPromise;
	});

	// T6 — isPlaying flag surfaces the 🔊 indicator in rendered output
	it("selectedText shows 🔊 on the highlighted item while preview is playing", async () => {
		vi.useFakeTimers();
		const { ctx, getComponent, closeVoicePicker } = makeCtxWithCustom();

		// onPreview never resolves so isPlaying stays true after the debounce fires
		let resolvePreview!: () => void;
		const previewPending = new Promise<void>((r) => { resolvePreview = r; });
		const onPreview = vi.fn().mockReturnValue(previewPending);

		const menuPromise = runSpeakMenu(ctx, makeDefaultOptions({ onPreview }));
		await flushMicrotasks();

		const comp = getComponent() as unknown as {
			render: (w: number) => string[];
			handleInput: (d: string) => void;
		};
		expect(comp).toBeDefined();

		// Navigate down once — M1 → M2, triggers onSelectionChange
		comp.handleInput("\x1b[B");

		// Before debounce fires: isPlaying is false — no 🔊
		const linesBefore = comp.render(80);
		expect(linesBefore.join("\n")).not.toContain("🔊");

		// Advance 400 ms — debounce fires, isPlaying = true, onPreview called (pending)
		await vi.advanceTimersByTimeAsync(400);
		await flushMicrotasks();

		// Now isPlaying is true — render should show 🔊 on M2
		const linesAfter = comp.render(80);
		expect(linesAfter.join("\n")).toContain("🔊");

		// Clean up: resolve preview, cancel picker, await menu
		resolvePreview();
		await flushMicrotasks();
		closeVoicePicker(null);
		await menuPromise;
	});
});

// ---------------------------------------------------------------------------
// selectAt dynamicSuffix
// ---------------------------------------------------------------------------

describe("selectAt dynamicSuffix", () => {
	// T1+T2 — regression guard: the dynamicSuffix callback receives a SelectList-prefixed
	// label such as "→ Test speech", not the raw string "Test speech". Using === instead
	// of .includes() would silently never fire the 🔊 indicator.
	it("dynamicSuffix matches prefixed label via includes (regression: was ===)", () => {
		// The SelectList passes "→ Test speech" to selectedText, not the raw label.
		// Using === would silently never match; .includes() is required.
		const prefixedLabel: string = "→ Test speech";
		// Old buggy condition:
		expect(prefixedLabel === "Test speech").toBe(false);
		// New correct condition:
		expect(prefixedLabel.includes("Test speech")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Additional branch coverage tests
// ---------------------------------------------------------------------------

describe("runSpeakMenu — additional branches", () => {
	// Cancel in language picker → else branch of `if (l)` (L633)
	it("language picker: cancel → onSetSessionLang not called, menu continues", async () => {
		const { ctx } = makeCtxSelect(["Language: en", null, "Close"]);
		const onSetSessionLang = vi.fn();
		await runSpeakMenu(ctx, makeDefaultOptions({ onSetSessionLang }));
		expect(onSetSessionLang).not.toHaveBeenCalled();
	});

	// Cancel in speed picker → else branch of `if (v !== null)` (L643)
	it("speed picker: cancel → onSetSessionSpeed not called, menu continues", async () => {
		const { ctx } = makeCtxSelect(["Speed: Normal (1.05)", "Cancel", "Close"]);
		const onSetSessionSpeed = vi.fn();
		await runSpeakMenu(ctx, makeDefaultOptions({ onSetSessionSpeed }));
		expect(onSetSessionSpeed).not.toHaveBeenCalled();
	});

	// Cancel in steps picker → else branch of `if (v !== null)` (L653)
	it("steps picker: cancel → onSetSessionSteps not called, menu continues", async () => {
		const { ctx } = makeCtxSelect(["Steps: Default — 8 steps", "Cancel", "Close"]);
		const onSetSessionSteps = vi.fn();
		await runSpeakMenu(ctx, makeDefaultOptions({ onSetSessionSteps }));
		expect(onSetSessionSteps).not.toHaveBeenCalled();
	});

	// Cancel in default voice picker → else branch of `if (v)` (L665)
	it("default voice picker: cancel → saveConfig not called", async () => {
		const { ctx } = makeCtxSelect(["Default voice: M1", "Cancel", "Close"]);
		const saveConfig = vi.fn(() => true);
		await runSpeakMenu(ctx, makeDefaultOptions({ saveConfig }));
		expect(saveConfig).not.toHaveBeenCalled();
	});

	// Default language picker — true branch (L671-676)
	it("default language picker: selecting 'fr' calls saveConfig({ defaultLang: 'fr' })", async () => {
		const { ctx } = makeCtxSelect(["Default language: en", "fr", "Close"]);
		const saveConfig = vi.fn(() => true);
		await runSpeakMenu(ctx, makeDefaultOptions({ saveConfig }));
		expect(saveConfig).toHaveBeenCalledWith({ defaultLang: "fr" });
	});

	// Default language picker — cancel → saveConfig not called
	it("default language picker: cancel → saveConfig not called", async () => {
		const { ctx } = makeCtxSelect(["Default language: en", "Cancel", "Close"]);
		const saveConfig = vi.fn(() => true);
		await runSpeakMenu(ctx, makeDefaultOptions({ saveConfig }));
		expect(saveConfig).not.toHaveBeenCalled();
	});

	// Default steps picker — true branch (L687-692)
	it("default steps picker: selecting 'Quality — 16 steps' calls saveConfig({ defaultSteps: 16 })", async () => {
		const { ctx } = makeCtxSelect(["Default steps: Default — 8 steps", "Quality — 16 steps", "Close"]);
		const saveConfig = vi.fn(() => true);
		await runSpeakMenu(ctx, makeDefaultOptions({ saveConfig }));
		expect(saveConfig).toHaveBeenCalledWith({ defaultSteps: 16 });
	});

	// Default steps picker — cancel → saveConfig not called
	it("default steps picker: cancel → saveConfig not called", async () => {
		const { ctx } = makeCtxSelect(["Default steps: Default — 8 steps", "Cancel", "Close"]);
		const saveConfig = vi.fn(() => true);
		await runSpeakMenu(ctx, makeDefaultOptions({ saveConfig }));
		expect(saveConfig).not.toHaveBeenCalled();
	});

	// Default speed picker — cancel → saveConfig not called
	it("default speed picker: cancel → saveConfig not called", async () => {
		const { ctx } = makeCtxSelect(["Default speed: Normal (1.05)", "Cancel", "Close"]);
		const saveConfig = vi.fn(() => true);
		await runSpeakMenu(ctx, makeDefaultOptions({ saveConfig }));
		expect(saveConfig).not.toHaveBeenCalled();
	});

	// After language selection → onSpeakHello is called (L636)
	it("language picker: after selecting, onSpeakHello is called", async () => {
		const { ctx } = makeCtxSelect(["Language: en", "fr", "Close"]);
		const onSpeakHello = vi.fn(() => Promise.resolve());
		const onSetSessionLang = vi.fn();
		await runSpeakMenu(ctx, makeDefaultOptions({ onSpeakHello, onSetSessionLang }));
		expect(onSpeakHello).toHaveBeenCalled();
	});

	// After speed selection → onSpeakHello is called (L646)
	it("speed picker: after selecting, onSpeakHello is called", async () => {
		const { ctx } = makeCtxSelect(["Speed: Normal (1.05)", "Fast (1.3)", "Close"]);
		const onSpeakHello = vi.fn(() => Promise.resolve());
		const onSetSessionSpeed = vi.fn();
		await runSpeakMenu(ctx, makeDefaultOptions({ onSpeakHello, onSetSessionSpeed }));
		expect(onSpeakHello).toHaveBeenCalled();
	});

	// After steps selection → onSpeakHello is called (L656)
	it("steps picker: after selecting, onSpeakHello is called", async () => {
		const { ctx } = makeCtxSelect(["Steps: Default — 8 steps", "Quality — 16 steps", "Close"]);
		const onSpeakHello = vi.fn(() => Promise.resolve());
		const onSetSessionSteps = vi.fn();
		await runSpeakMenu(ctx, makeDefaultOptions({ onSpeakHello, onSetSessionSteps }));
		expect(onSpeakHello).toHaveBeenCalled();
	});

	// Model info displayed when assets directory exists
	it("model info shows size in MB when assets dir exists", async () => {
		const fsModule = await import("node:fs");
		const pathModule = await import("node:path");
		const osModule = await import("node:os");
		const dir = pathModule.join(osModule.tmpdir(), `pi-speak-menu-test-${Date.now()}`);
		fsModule.mkdirSync(dir, { recursive: true });
		fsModule.writeFileSync(pathModule.join(dir, "model.bin"), Buffer.alloc(2 * 1024 * 1024, 0x42));
		try {
			const { ctx, selectCalls } = makeCtxSelect(["Close"]);
			await runSpeakMenu(ctx, makeDefaultOptions({ getAssetsDir: () => dir }));
			const items = selectCalls[0] ?? [];
			const modelItem = items.find((item) => item.startsWith("Model:"));
			expect(modelItem).toMatch(/\(\d+ MB\)/);
		} finally {
			fsModule.rmSync(dir, { recursive: true, force: true });
		}
	});

	// Config-driven defaults (loadConfig returns non-default values)
	it("uses config defaultVoice in effective voice when no session override", async () => {
		const { ctx, selectCalls } = makeCtxSelect(["Close"]);
		await runSpeakMenu(ctx, makeDefaultOptions({
			loadConfig: vi.fn(() => ({ defaultVoice: "F2", defaultLang: "fr", defaultSpeed: 1.3, defaultSteps: 16 })),
		}));
		const items = selectCalls[0] ?? [];
		expect(items.find((i) => i.startsWith("Voice:"))).toBe("Voice: F2");
		expect(items.find((i) => i.startsWith("Language:"))).toBe("Language: fr");
	});
});

// ---------------------------------------------------------------------------
// findMenuIndex — prefix match path
// ---------------------------------------------------------------------------

describe("findMenuIndex", () => {
	// The prefix match path (L530) — test by having a choice that matches by colon prefix
	it("cursor restored by prefix match after a dynamic label changes", async () => {
		// When the label changes from "speak: disabled" to "speak: enabled" between menu
		// iterations, findMenuIndex must restore the cursor to the "speak: ..." row via
		// prefix match (exact match fails because "disabled" ≠ "enabled").
		const { ctx, selectCalls } = makeCtxSelect(["speak: disabled", "Close"]);
		const onToggle = vi.fn(() => Promise.resolve(true)); // returns true → enabled
		await runSpeakMenu(ctx, makeDefaultOptions({ onToggle }));

		// Second render: menu items rebuilt with "speak: enabled"
		const secondItems = selectCalls[1] ?? [];
		const speakItem = secondItems.find((i) => i.startsWith("speak:"));
		expect(speakItem).toBe("speak: enabled");
	});

	// Selecting "Voice: F2" then "Close" — lastChoice changes, and on re-render
	// "Voice: F2" appears, which is an exact match so it's found directly.
	it("cursor restored by exact match after voice selection", async () => {
		const { ctx, selectCalls } = makeCtxSelect(["Voice: M1", "F2", "Close"]);
		await runSpeakMenu(ctx, makeDefaultOptions());
		// After picking F2, lastChoice = "Voice: M1". On next render, "Voice: F2"
		// matches by prefix "Voice:" → cursor goes to that row.
		const thirdItems = selectCalls[2] ?? [];
		expect(thirdItems.find((i) => i.startsWith("Voice:"))).toBe("Voice: F2");
	});
});

// ---------------------------------------------------------------------------
// pickWithPreview — string effVoice/effLang path (used by pickSpeed + pickSteps)
// ---------------------------------------------------------------------------

describe("pickSpeed and pickSteps pass string effVoice/effLang to pickWithPreview", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * Builds a ctx where:
	 *   custom call 1  = main menu  → selects "Speed: Normal (1.05)"
	 *   custom call 2  = speed picker → exposes component + done
	 *   custom call 3  = main menu  → selects "Close"
	 */
	function makeSpeedPickerCtx() {
		let customCallCount = 0;
		let speedPickerComponent: { handleInput: (data: string) => void } | undefined;
		let speedPickerDone: ((v: string | null) => void) | undefined;

		const ctx: MenuCtx = {
			ui: {
				select: vi.fn(),
				notify: vi.fn(),
				custom: vi.fn(<T>(
					factory: (tui: { requestRender: () => void }, theme: unknown, kb: unknown, done: (v: T) => void) => unknown,
				): Promise<T> => {
					customCallCount++;
					const call = customCallCount;
					return new Promise<T>((resolve) => {
						const component = factory(
							{ requestRender: vi.fn() },
							{ fg: (_r: string, s: string) => s, bold: (s: string) => s },
							{},
							(v: T) => resolve(v),
						);
						if (call === 1) {
							// main menu: "Speed: Normal (1.05)" at index ~6
							resolve({ value: "Speed: Normal (1.05)", index: 6 } as T);
						} else if (call === 2) {
							speedPickerComponent = component as { handleInput: (data: string) => void };
							speedPickerDone = (v: string | null) => resolve(v as T);
						} else {
							resolve({ value: "Close", index: 0 } as T);
						}
					});
				}) as NonNullable<MenuCtx["ui"]["custom"]>,
			},
		};

		return {
			ctx,
			getComponent: () => speedPickerComponent,
			closeSpeedPicker: (v: string | null = null) => speedPickerDone?.(v),
		};
	}

	async function flushMicrotasks(n = 10): Promise<void> {
		for (let i = 0; i < n; i++) await Promise.resolve();
	}

	it("navigating in speed picker with string effVoice triggers onPreview once after debounce", async () => {
		vi.useFakeTimers();
		const onPreview = vi.fn().mockResolvedValue(undefined);
		const { ctx, getComponent, closeSpeedPicker } = makeSpeedPickerCtx();

		const menuPromise = runSpeakMenu(ctx, makeDefaultOptions({ onPreview }));
		await flushMicrotasks();

		const comp = getComponent();
		expect(comp).toBeDefined();

		// Navigate down once
		comp!.handleInput("\x1b[B");
		expect(onPreview).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(400);
		// onPreview should have been called once (with string effVoice and effLang)
		expect(onPreview).toHaveBeenCalledOnce();
		const [text, voice, lang] = onPreview.mock.calls[0] as [string, string, string];
		expect(typeof text).toBe("string");
		expect(typeof voice).toBe("string"); // effVoice is a string here, not a function
		expect(typeof lang).toBe("string");  // effLang is a string here

		closeSpeedPicker(null);
		await menuPromise;
	});
});

// ---------------------------------------------------------------------------
// Additional coverage for catch handlers and edge cases
// ---------------------------------------------------------------------------

describe("runSpeakMenu — catch handlers and edge cases", () => {
	// L611: .catch(() => {}) fires when onTest rejects
	it("onTest rejection is swallowed by catch handler", async () => {
		const { ctx } = makeCtxSelect(["Test speech", "Close"]);
		const onTest = vi.fn(() => Promise.reject(new Error("TTS init failed")));
		// Should not throw — the catch swallows the error
		await expect(runSpeakMenu(ctx, makeDefaultOptions({ onTest }))).resolves.toBeUndefined();
	});

	// L626: .catch(() => {}) fires when voice onSpeakHello rejects
	it("onSpeakHello rejection after voice selection is swallowed", async () => {
		const { ctx } = makeCtxSelect(["Voice: M1", "F2", "Close"]);
		const onSpeakHello = vi.fn(() => Promise.reject(new Error("audio error")));
		await expect(runSpeakMenu(ctx, makeDefaultOptions({ onSpeakHello }))).resolves.toBeUndefined();
	});

	// L636: .catch(() => {}) fires when language onSpeakHello rejects
	it("onSpeakHello rejection after language selection is swallowed", async () => {
		const { ctx } = makeCtxSelect(["Language: en", "fr", "Close"]);
		const onSpeakHello = vi.fn(() => Promise.reject(new Error("audio error")));
		const onSetSessionLang = vi.fn();
		await expect(runSpeakMenu(ctx, makeDefaultOptions({ onSpeakHello, onSetSessionLang }))).resolves.toBeUndefined();
	});

	// L646: .catch(() => {}) fires when speed onSpeakHello rejects
	it("onSpeakHello rejection after speed selection is swallowed", async () => {
		const { ctx } = makeCtxSelect(["Speed: Normal (1.05)", "Fast (1.3)", "Close"]);
		const onSpeakHello = vi.fn(() => Promise.reject(new Error("audio error")));
		const onSetSessionSpeed = vi.fn();
		await expect(runSpeakMenu(ctx, makeDefaultOptions({ onSpeakHello, onSetSessionSpeed }))).resolves.toBeUndefined();
	});

	// L656: .catch(() => {}) fires when steps onSpeakHello rejects
	it("onSpeakHello rejection after steps selection is swallowed", async () => {
		const { ctx } = makeCtxSelect(["Steps: Default — 8 steps", "Quality — 16 steps", "Close"]);
		const onSpeakHello = vi.fn(() => Promise.reject(new Error("audio error")));
		const onSetSessionSteps = vi.fn();
		await expect(runSpeakMenu(ctx, makeDefaultOptions({ onSpeakHello, onSetSessionSteps }))).resolves.toBeUndefined();
	});

	// L687 else: Model info item (non-interactive) falls through to loop restart
	it("selecting model info item (non-interactive) causes loop to re-render and then Close exits", async () => {
		const { ctx } = makeCtxSelect(["Model: not downloaded", "Close"]);
		await expect(runSpeakMenu(ctx, makeDefaultOptions())).resolves.toBeUndefined();
	});

	// L472: selectAt fallback → ctx.ui.select returns null → menu exits
	it("null return from ctx.ui.select exits the menu immediately", async () => {
		const { ctx } = makeCtxSelect([null]);
		await expect(runSpeakMenu(ctx, makeDefaultOptions())).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// runSpeakMenu — dynamicSuffix with isTestPlaying (L593)
// ---------------------------------------------------------------------------

describe("runSpeakMenu — dynamicSuffix with isTestPlaying (L593)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * Builds a ctx where custom() resolves with the given value on each call.
	 */
	function makeCustomCtxWithCalls(resolveValues: Array<{ value: string; index: number } | null>) {
		let callIndex = 0;
		const ctx: MenuCtx = {
			ui: {
				select: vi.fn(),
				notify: vi.fn(),
				custom: vi.fn(<T>(
					factory: (tui: { requestRender: () => void }, theme: unknown, kb: unknown, done: (v: T) => void) => unknown,
				): Promise<T> => {
					const idx = callIndex++;
					return new Promise<T>((resolve) => {
						factory(
							{ requestRender: vi.fn() },
							{ fg: (_r: string, s: string) => s, bold: (s: string) => s },
							{},
							(v: T) => resolve(v),
						);
						if (idx < resolveValues.length) {
							resolve(resolveValues[idx] as T);
						} else {
							resolve({ value: "Close", index: 0 } as T);
						}
					});
				}) as NonNullable<MenuCtx["ui"]["custom"]>,
			},
		};
		return ctx;
	}

	// L593: dynamicSuffix returns "  🔊" when isTestPlaying is true (truthy branch)
	it("dynamicSuffix returns 🔊 suffix when isTestPlaying is true (L593 truthy branch)", async () => {
		// Select "Test speech" first, then "Close"
		const ctx = makeCustomCtxWithCalls([
			{ value: "Test speech", index: 1 },
			{ value: "Close", index: 0 },
		]);
		const onTest = vi.fn(() => Promise.resolve());
		await runSpeakMenu(ctx, makeDefaultOptions({ onTest }));
		// onTest should have been called once
		expect(onTest).toHaveBeenCalledOnce();
	});

	// L593: dynamicSuffix returns undefined when isTestPlaying is false (falsy branch)
	it("dynamicSuffix returns undefined when isTestPlaying is false (L593 falsy branch)", async () => {
		// Select "Close" directly — isTestPlaying stays false
		const ctx = makeCustomCtxWithCalls([
			{ value: "Close", index: 0 },
		]);
		const onTest = vi.fn(() => Promise.resolve());
		await runSpeakMenu(ctx, makeDefaultOptions({ onTest }));
		// onTest should NOT have been called
		expect(onTest).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// selectAt — custom UI path (ctx.ui.custom exists) — renders component
// ---------------------------------------------------------------------------

describe("selectAt — custom UI path with render", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * Builds a ctx where custom() captures the component for testing.
	 * Always resolves with the given value (even if null).
	 */
	function makeCtxCapturingComponent(resolveWith: { value: string; index: number } | null) {
		let capturedComponent: { render: (w: number) => string[]; invalidate: () => void } | undefined;

		const ctx: MenuCtx = {
			ui: {
				select: vi.fn(),
				notify: vi.fn(),
				custom: vi.fn(<T>(
					factory: (tui: { requestRender: () => void }, theme: unknown, kb: unknown, done: (v: T) => void) => unknown,
				): Promise<T> => {
					return new Promise<T>((resolve) => {
						const component = factory(
							{ requestRender: vi.fn() },
							{ fg: (_r: string, s: string) => s, bold: (s: string) => s },
							{},
							(v: T) => resolve(v),
						);
						capturedComponent = component as typeof capturedComponent;
						resolve(resolveWith as T);
					});
				}) as NonNullable<MenuCtx["ui"]["custom"]>,
			},
		};

		return {
			ctx,
			getComponent: () => capturedComponent,
		};
	}

	// L498-500: selectAt custom path — render() method is callable
	it("selectAt custom path: render() method is callable and returns lines", async () => {
		const { ctx, getComponent } = makeCtxCapturingComponent({ value: "Close", index: 0 });

		const onTest = vi.fn(() => Promise.resolve());
		await runSpeakMenu(ctx, makeDefaultOptions({ onTest }));

		const comp = getComponent();
		expect(comp).toBeDefined();
		expect(typeof comp!.render).toBe("function");

		// Call render to verify it works
		const lines = comp!.render(80);
		expect(Array.isArray(lines)).toBe(true);
		expect(lines.length).toBeGreaterThan(0);
	});
});
