import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DEFAULT_POLICY, type CompactionPolicy } from "../src/policy/types.js";
import { getLastAssistantMessage, resolveSummaryModel } from "../src/runtime/model-resolution.js";

describe("getLastAssistantMessage", () => {
	it("returns the last assistant message in the array", () => {
		const messages = [
			{ role: "assistant", id: 1 },
			{ role: "user", id: 2 },
			{ role: "assistant", id: 3 },
		] as never[];

		assert.deepEqual(getLastAssistantMessage(messages), { role: "assistant", id: 3 });
	});

	it("returns undefined for an empty message array", () => {
		assert.equal(getLastAssistantMessage([]), undefined);
	});

	it("skips non-assistant messages", () => {
		const messages = [
			{ role: "user", id: 1 },
			{ role: "tool", id: 2 },
		] as never[];

		assert.equal(getLastAssistantMessage(messages), undefined);
	});
});

describe("resolveSummaryModel", () => {
	it("reports invalid selectors instead of silently skipping", async () => {
		const notifications: string[] = [];
		const policy: CompactionPolicy = {
			...DEFAULT_POLICY,
			enabled: true,
			trigger: { ...DEFAULT_POLICY.trigger },
			models: [{ model: "invalid-selector" }],
			ui: { ...DEFAULT_POLICY.ui },
			summary: { ...DEFAULT_POLICY.summary },
		};
		const ctx = {
			modelRegistry: {
				find: () => undefined,
				getApiKeyAndHeaders: () => Promise.resolve({ ok: true, apiKey: "k", headers: {} }),
			},
		} as never;

		const result = await resolveSummaryModel(
			ctx,
			policy,
			(_ctx, _policy, _level, message) => {
				notifications.push(message);
				return true;
			},
		);

		assert.equal(result, undefined);
		assert.match(notifications[0] ?? "", /invalid-selector: expected model selector provider\/modelId/);
	});

	it("handles thrown model-registry auth errors as typed resolution failures", async () => {
		const notifications: string[] = [];
		const policy: CompactionPolicy = {
			...DEFAULT_POLICY,
			enabled: true,
			trigger: { ...DEFAULT_POLICY.trigger },
			models: [{ model: "openai/gpt-test" }],
			ui: { ...DEFAULT_POLICY.ui },
			summary: { ...DEFAULT_POLICY.summary },
		};
		const ctx = {
			modelRegistry: {
				find: () => ({ provider: "openai", id: "gpt-test" }),
				getApiKeyAndHeaders: () => Promise.reject(new Error("network unavailable")),
			},
		} as never;

		const result = await resolveSummaryModel(
			ctx,
			policy,
			(_ctx, _policy, _level, message) => {
				notifications.push(message);
				return true;
			},
		);

		assert.equal(result, undefined);
		assert.match(notifications[0] ?? "", /openai\/gpt-test: failed to resolve model auth \(network unavailable\)/);
	});
});

	it("resolves successfully and returns entry with model, apiKey, and headers", async () => {
		const mockModel = { provider: "openai", id: "gpt-4" };
		const policy: CompactionPolicy = {
			...DEFAULT_POLICY,
			enabled: true,
			trigger: { ...DEFAULT_POLICY.trigger },
			models: [{ model: "openai/gpt-4" }],
			ui: { ...DEFAULT_POLICY.ui },
			summary: { ...DEFAULT_POLICY.summary },
		};
		const ctx = {
			modelRegistry: {
				find: () => mockModel,
				getApiKeyAndHeaders: () => Promise.resolve({ ok: true, apiKey: "sk-test", headers: { Authorization: "Bearer sk-test" } }),
			},
		} as never;

		const result = await resolveSummaryModel(ctx, policy, () => true);

		assert.ok(result !== undefined);
		assert.deepEqual(result.model, mockModel);
		assert.equal(result.apiKey, "sk-test");
		assert.deepEqual(result.headers, { Authorization: "Bearer sk-test" });
	});

	it("returns failure reason when auth.ok is false (getApiKeyAndHeaders returns ok:false)", async () => {
		const notifications: string[] = [];
		const policy: CompactionPolicy = {
			...DEFAULT_POLICY,
			enabled: true,
			trigger: { ...DEFAULT_POLICY.trigger },
			models: [{ model: "openai/gpt-4" }],
			ui: { ...DEFAULT_POLICY.ui },
			summary: { ...DEFAULT_POLICY.summary },
		};
		const ctx = {
			modelRegistry: {
				find: () => ({ provider: "openai", id: "gpt-4" }),
				getApiKeyAndHeaders: () => Promise.resolve({ ok: false, error: "no API key configured" }),
			},
		} as never;

		const result = await resolveSummaryModel(ctx, policy, (_ctx, _policy, _level, message) => {
			notifications.push(message);
			return true;
		});

		assert.equal(result, undefined);
		assert.match(notifications[0] ?? "", /no API key configured/);
	});

	it("handles non-Error thrown (uses String fallback)", async () => {
		const notifications: string[] = [];
		const policy: CompactionPolicy = {
			...DEFAULT_POLICY,
			enabled: true,
			trigger: { ...DEFAULT_POLICY.trigger },
			models: [{ model: "openai/gpt-4" }],
			ui: { ...DEFAULT_POLICY.ui },
			summary: { ...DEFAULT_POLICY.summary },
		};
		const ctx = {
			modelRegistry: {
				find: () => ({ provider: "openai", id: "gpt-4" }),
                getApiKeyAndHeaders: () => Promise.reject(new Error("string-error")),
			},
		} as never;

		const result = await resolveSummaryModel(ctx, policy, (_ctx, _policy, _level, message) => {
			notifications.push(message);
			return true;
		});

		assert.equal(result, undefined);
		assert.match(notifications[0] ?? "", /string-error/);
	});

// ---------------------------------------------------------------------------
// tryResolveModel — model-not-found branch (line 45)
// ---------------------------------------------------------------------------
describe("tryResolveModel — model not found", () => {
	it("reports model-not-found when modelRegistry.find returns undefined", async () => {
		const notifications: string[] = [];
		const policy: CompactionPolicy = {
			...DEFAULT_POLICY,
			enabled: true,
			trigger: { ...DEFAULT_POLICY.trigger },
			models: [{ model: "openai/gpt-4" }],
			ui: { ...DEFAULT_POLICY.ui },
			summary: { ...DEFAULT_POLICY.summary },
		};
		const ctx = {
			modelRegistry: {
				find: () => undefined, // model not found
				getApiKeyAndHeaders: () => Promise.resolve({ ok: true }),
			},
		} as never;

		const result = await resolveSummaryModel(ctx, policy, (_ctx, _policy, _level, message) => {
			notifications.push(message);
			return true;
		});

		assert.equal(result, undefined);
		assert.match(notifications[0] ?? "", /model not found: openai\/gpt-4/);
	});
});

// ---------------------------------------------------------------------------
// tryResolveModel / resolveSummaryModel — optional apiKey/headers branches
// Lines 52-53 and 76-77: the `{}` spread arms when apiKey or headers is absent.
// ---------------------------------------------------------------------------
describe("resolveSummaryModel — optional apiKey/headers spreads", () => {
	it("omits apiKey and headers fields when both are undefined in auth response", async () => {
		const mockModel = { provider: "openai", id: "gpt-4" };
		const policy: CompactionPolicy = {
			...DEFAULT_POLICY,
			enabled: true,
			trigger: { ...DEFAULT_POLICY.trigger },
			models: [{ model: "openai/gpt-4" }],
			ui: { ...DEFAULT_POLICY.ui },
			summary: { ...DEFAULT_POLICY.summary },
		};
		const ctx = {
			modelRegistry: {
				find: () => mockModel,
				// Return ok:true but with apiKey and headers both undefined
				getApiKeyAndHeaders: () => Promise.resolve({ ok: true, apiKey: undefined, headers: undefined }),
			},
		} as never;

		const result = await resolveSummaryModel(ctx, policy, () => true);

		assert.ok(result !== undefined);
		assert.deepEqual(result.model, mockModel);
		// Neither apiKey nor headers should be present on the result
		assert.equal(("apiKey" in result), false);
		assert.equal(("headers" in result), false);
	});

	it("includes only apiKey when headers is undefined", async () => {
		const mockModel = { provider: "openai", id: "gpt-4" };
		const policy: CompactionPolicy = {
			...DEFAULT_POLICY,
			enabled: true,
			trigger: { ...DEFAULT_POLICY.trigger },
			models: [{ model: "openai/gpt-4" }],
			ui: { ...DEFAULT_POLICY.ui },
			summary: { ...DEFAULT_POLICY.summary },
		};
		const ctx = {
			modelRegistry: {
				find: () => mockModel,
				getApiKeyAndHeaders: () => Promise.resolve({ ok: true, apiKey: "sk-abc", headers: undefined }),
			},
		} as never;

		const result = await resolveSummaryModel(ctx, policy, () => true);

		assert.ok(result !== undefined);
		assert.equal(result.apiKey, "sk-abc");
		assert.equal(("headers" in result), false);
	});
});

// ---------------------------------------------------------------------------
// tryResolveModel — non-Error thrown (String(error) branch at line 56)
// ---------------------------------------------------------------------------
describe("tryResolveModel — non-Error thrown object", () => {
	it("uses String() fallback when a non-Error is thrown from getApiKeyAndHeaders", async () => {
		const notifications: string[] = [];
		const policy: CompactionPolicy = {
			...DEFAULT_POLICY,
			enabled: true,
			trigger: { ...DEFAULT_POLICY.trigger },
			models: [{ model: "openai/gpt-4" }],
			ui: { ...DEFAULT_POLICY.ui },
			summary: { ...DEFAULT_POLICY.summary },
		};
		const ctx = {
			modelRegistry: {
				find: () => ({ provider: "openai", id: "gpt-4" }),
				// Throw a plain string (not an Error instance)
				getApiKeyAndHeaders: () => Promise.reject(new Error("plain-string-error")),
			},
		} as never;

		const result = await resolveSummaryModel(ctx, policy, (_ctx, _policy, _level, message) => {
			notifications.push(message);
			return true;
		});

		assert.equal(result, undefined);
		// The notification should contain the stringified error
		assert.match(notifications[0] ?? "", /plain-string-error/);
	});
});

// ---------------------------------------------------------------------------
// resolveSummaryModel — empty failures list (detail = "" branch at line 82)
// ---------------------------------------------------------------------------
describe("resolveSummaryModel — no models in policy (empty failures list)", () => {
	it("notifies without details when policy has no models at all", async () => {
		const notifications: string[] = [];
		const policy: CompactionPolicy = {
			...DEFAULT_POLICY,
			enabled: true,
			trigger: { ...DEFAULT_POLICY.trigger },
			models: [], // empty — failures will be empty too
			ui: { ...DEFAULT_POLICY.ui },
			summary: { ...DEFAULT_POLICY.summary },
		};
		const ctx = {
			modelRegistry: {
				find: () => undefined,
				getApiKeyAndHeaders: () => Promise.resolve({ ok: true }),
			},
		} as never;

		const result = await resolveSummaryModel(ctx, policy, (_ctx, _policy, _level, message) => {
			notifications.push(message);
			return true;
		});

		assert.equal(result, undefined);
		// detail should be empty (failures.length === 0) so no "[...]" suffix
		assert.ok(notifications[0] !== undefined);
		assert.ok(!(notifications[0] ?? "").includes("["), `Unexpected detail in: ${notifications[0]}`);
	});
});
