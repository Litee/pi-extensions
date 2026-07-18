import { describe, expect, it, vi } from "vitest";

import { Runtime } from "../src/runtime.js";

function modelRegistry(args: { found?: unknown; auth?: unknown } = {}) {
	return {
		find: vi.fn(() => args.found),
		getApiKeyAndHeaders: vi.fn(() => Promise.resolve(args.auth ?? { ok: true, apiKey: "key", headers: { test: "yes" } })),
	};
}

describe("Runtime V3 behavior", () => {
	it("uses configured model when present", async () => {
		const runtime = new Runtime();
		const configured = { provider: "anthropic", id: "configured" };
		const registry = modelRegistry({ found: configured });
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "configured" } };

		const result = await runtime.resolveModel({ model: { provider: "openai" }, modelRegistry: registry, hasUI: false });

		expect(registry.find).toHaveBeenCalledWith("anthropic", "configured");
		expect(result).toEqual({ ok: true, model: configured, apiKey: "key", headers: { test: "yes" } });
	});

	it("falls back to session model and notifies when configured model is missing", async () => {
		const runtime = new Runtime();
		const notify = vi.fn();
		const sessionModel = { provider: "openai" };
		const registry = modelRegistry();
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "missing" } };

		const result = await runtime.resolveModel({ model: sessionModel, modelRegistry: registry, hasUI: true, ui: { notify } });

		expect(result).toMatchObject({ ok: true, model: sessionModel });
		expect(notify).toHaveBeenCalledWith(
			"Observational memory: configured model anthropic/missing not found, using session model",
			"warning",
		);
	});

	it("returns model resolution failures", async () => {
		const runtime = new Runtime();
		await expect(runtime.resolveModel({ model: undefined, modelRegistry: modelRegistry(), hasUI: false })).resolves.toEqual({
			ok: false,
			reason: "no model available (session has no model and no observational-memory model configured)",
		});

		const registry = modelRegistry({ auth: { ok: false } });
		await expect(runtime.resolveModel({ model: { provider: "anthropic" }, modelRegistry: registry, hasUI: false })).resolves.toEqual({
			ok: false,
			reason: 'no API key for provider "anthropic"',
		});
	});

	it("tracks consolidation task state", async () => {
		const runtime = new Runtime();
		let release: (() => void) | undefined;
		const work = new Promise<void>((resolve) => {
			release = resolve;
		});

		const promise = runtime.launchConsolidationTask({ hasUI: false }, async () => {
			runtime.consolidationPhase = "observer";
			await work;
		});

		expect(runtime.consolidationInFlight).toBe(true);
		expect(runtime.consolidationPromise).toBe(promise);
		expect(runtime.consolidationPhase).toBe("observer");
		release?.();
		await promise;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPromise).toBeNull();
		expect(runtime.consolidationPhase).toBeUndefined();
	});

	it("records stage-specific consolidation errors", () => {
		const runtime = new Runtime();
		const notify = vi.fn();

		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "observer", new Error("observe failed"))).toBe("observe failed");
		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "reflector", new Error("reflect failed"))).toBe("reflect failed");
		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "dropper", "drop failed")).toBe("drop failed");

		expect(runtime.lastObserverError).toBe("observe failed");
		expect(runtime.lastReflectorError).toBe("reflect failed");
		expect(runtime.lastDropperError).toBe("drop failed");
		expect(notify).toHaveBeenCalledWith("Observational memory: observer failed: observe failed", "warning");
		expect(notify).toHaveBeenCalledWith("Observational memory: reflector failed: reflect failed", "warning");
		expect(notify).toHaveBeenCalledWith("Observational memory: dropper failed: drop failed", "warning");
	});

	it("keeps compaction flags independent", () => {
		const runtime = new Runtime();
		runtime.compactInFlight = true;
		runtime.compactHookInFlight = true;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPhase).toBeUndefined();
	});

	it("notifies when configured model is not found and hasUI is true", async () => {
		const runtime = new Runtime();
		const notify = vi.fn();
		const sessionModel = { provider: "openai" };
		const registry = modelRegistry({ found: undefined });
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "missing" } };

		const result = await runtime.resolveModel({ model: sessionModel, modelRegistry: registry, hasUI: true, ui: { notify } });

		expect(notify).toHaveBeenCalledWith(
			"Observational memory: configured model anthropic/missing not found, using session model",
			"warning",
		);
		expect(result).toMatchObject({ ok: true, model: sessionModel });
	});

	it("does not notify when configured model is not found and hasUI is false", async () => {
		const runtime = new Runtime();
		const notify = vi.fn();
		const sessionModel = { provider: "openai" };
		const registry = modelRegistry({ found: undefined });
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "missing" } };

		const result = await runtime.resolveModel({ model: sessionModel, modelRegistry: registry, hasUI: false, ui: { notify } });

		expect(notify).not.toHaveBeenCalled();
		expect(result).toMatchObject({ ok: true, model: sessionModel });
	});

	it("returns failure when no model is available and no config exists", async () => {
		const runtime = new Runtime();
		// Reset config to defaults (no model configured)
		runtime.config = { ...runtime.config, model: undefined };

		const result = await runtime.resolveModel({ model: undefined, modelRegistry: modelRegistry(), hasUI: false });

		expect(result).toEqual({
			ok: false,
			reason: "no model available (session has no model and no observational-memory model configured)",
		});
	});

	it("returns failure when API key auth fails", async () => {
		const runtime = new Runtime();
		runtime.config = { ...runtime.config, model: undefined };
		const registry = modelRegistry({
			found: { provider: "anthropic" },
			auth: { ok: false, error: "no key" },
		});

		const result = await runtime.resolveModel({
			model: { provider: "anthropic" },
			modelRegistry: registry,
			hasUI: false,
		});

		expect(result).toEqual({ ok: false, reason: 'no API key for provider "anthropic"' });
	});

	it("returns failure when apiKey is missing from auth response", async () => {
		const runtime = new Runtime();
		runtime.config = { ...runtime.config, model: undefined };
		const registry = modelRegistry({
			found: { provider: "anthropic" },
			auth: { ok: true, apiKey: undefined, headers: {} },
		});

		const result = await runtime.resolveModel({
			model: { provider: "anthropic" },
			modelRegistry: registry,
			hasUI: false,
		});

		expect(result).toEqual({ ok: false, reason: 'no API key for provider "anthropic"' });
	});

	it("includes headers when auth provides them", async () => {
		const runtime = new Runtime();
		runtime.config = { ...runtime.config, model: undefined };
		const registry = modelRegistry({
			found: { provider: "anthropic" },
			auth: { ok: true, apiKey: "key", headers: { Authorization: "Bearer x" } },
		});

		const result = await runtime.resolveModel({
			model: { provider: "anthropic" },
			modelRegistry: registry,
			hasUI: false,
		});

		expect(result).toEqual({
			ok: true,
			model: { provider: "anthropic" },
			apiKey: "key",
			headers: { Authorization: "Bearer x" },
		});
	});

	it("handles errors thrown inside launchTrackedTask work function", async () => {
		const runtime = new Runtime();
		const notify = vi.fn();

		const promise = runtime.launchConsolidationTask({ hasUI: true, ui: { notify } }, async () => {
			runtime.consolidationPhase = "observer";
			throw new Error("work failed");
		});

		await expect(promise).resolves.toBeUndefined();
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPromise).toBeNull();
		expect(runtime.consolidationPhase).toBeUndefined();
		expect(notify).toHaveBeenCalledWith("Observational memory: consolidation failed: work failed", "warning");
	});

	it("handles errors thrown inside launchTrackedTask without UI", async () => {
		const runtime = new Runtime();

		const promise = runtime.launchConsolidationTask({ hasUI: false }, async () => {
			runtime.consolidationPhase = "observer";
			throw new Error("silent work failed");
		});

		await expect(promise).resolves.toBeUndefined();
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPhase).toBeUndefined();
	});

	it("tracks string error messages from launchTrackedTask", () => {
		const runtime = new Runtime();
		const notify = vi.fn();

		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "observer", "string error")).toBe("string error");
		expect(runtime.lastObserverError).toBe("string error");
	});
});
