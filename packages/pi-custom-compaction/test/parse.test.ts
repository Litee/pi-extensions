import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseModelSelector, parsePolicyPatch } from "../src/policy/parse.js";

describe("parsePolicyPatch", () => {
	it("accepts an empty object as an empty patch", () => {
		const result = parsePolicyPatch({});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.value, {});
	});

	it("parses enabled true and false", () => {
		const enabled = parsePolicyPatch({ enabled: true });
		assert.deepEqual(enabled, { ok: true, value: { enabled: true } });

		const disabled = parsePolicyPatch({ enabled: false });
		assert.deepEqual(disabled, { ok: true, value: { enabled: false } });
	});

	it("parses trigger values", () => {
		const result = parsePolicyPatch({
			trigger: {
				maxTokens: "200000",
				minTokens: 100000,
				cooldownMs: 60000,
				builtinReserveTokens: "16384",
				builtinSkipMarginPercent: "7.5",
			},
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.value.trigger, {
			maxTokens: 200000,
			minTokens: 100000,
			cooldownMs: 60000,
			builtinReserveTokens: 16384,
			builtinSkipMarginPercent: 7.5,
		});
	});

	it("parses ui section values", () => {
		const result = parsePolicyPatch({
			ui: { name: "compact-status", quiet: "true", showStatus: false, minimalStatus: "false" },
		});
		assert.deepEqual(result, {
			ok: true,
			value: { ui: { name: "compact-status", quiet: true, showStatus: false, minimalStatus: false } },
		});
	});

	it("parses summary section values", () => {
		const result = parsePolicyPatch({
			summary: { thinkingLevel: "medium", preservationInstruction: "Keep exact errors." },
		});
		assert.deepEqual(result, {
			ok: true,
			value: { summary: { thinkingLevel: "medium", preservationInstruction: "Keep exact errors." } },
		});
	});

	it("parses summaryRetention in both tokens and percent modes", () => {
		assert.deepEqual(parsePolicyPatch({ summaryRetention: { mode: "tokens", value: "24000" } }), {
			ok: true,
			value: { summaryRetention: { mode: "tokens", value: 24000 } },
		});

		assert.deepEqual(parsePolicyPatch({ summaryRetention: { mode: "percent", value: "20" } }), {
			ok: true,
			value: { summaryRetention: { mode: "percent", value: 20 } },
		});
	});

	it("parses models array with string and object entries", () => {
		const result = parsePolicyPatch({
			models: [
				"openai/gpt-4",
				{
					model: "anthropic/claude-3-opus",
					thinkingLevel: "high",
					preservationInstruction: "Keep all stack traces.",
				},
			],
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.value.models, [
			{ model: "openai/gpt-4" },
			{
				model: "anthropic/claude-3-opus",
				thinkingLevel: "high",
				preservationInstruction: "Keep all stack traces.",
			},
		]);
	});

	it("parses profiles with trigger, models, summary, retention, and template overrides", () => {
		const result = parsePolicyPatch({
			profiles: {
				codex: {
					match: "openai/gpt-4",
					trigger: { minTokens: "80000", builtinSkipMarginPercent: 4.5 },
					models: ["anthropic/claude-haiku-4-5"],
					summary: {
						thinkingLevel: "low",
						preservationInstruction: "Preserve filenames and error text.",
					},
					summaryRetention: { mode: "percent", value: 15 },
					template: "~/.pi/agent/templates/codex.md",
					updateTemplate: "~/.pi/agent/templates/codex-update.md",
				},
			},
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.value.profiles, {
			codex: {
				match: "openai/gpt-4",
				trigger: { minTokens: 80000, builtinSkipMarginPercent: 4.5 },
				models: [{ model: "anthropic/claude-haiku-4-5" }],
				summary: {
					thinkingLevel: "low",
					preservationInstruction: "Preserve filenames and error text.",
				},
				summaryRetention: { mode: "percent", value: 15 },
				template: "~/.pi/agent/templates/codex.md",
				updateTemplate: "~/.pi/agent/templates/codex-update.md",
			},
		});
	});

	it("rejects non-object input", () => {
		for (const input of [null, [], "text", 42]) {
			assert.deepEqual(parsePolicyPatch(input), { ok: false, error: "Policy patch must be an object" });
		}
	});

	it("rejects unknown top-level keys", () => {
		assert.deepEqual(parsePolicyPatch({ nope: true }), {
			ok: false,
			error: "Unknown policy key: nope",
		});
	});

	it("rejects unknown trigger keys", () => {
		assert.deepEqual(parsePolicyPatch({ trigger: { unknown: 1 } }), {
			ok: false,
			error: "Unknown policy key: trigger.unknown",
		});
	});

	it("rejects invalid types for enabled, trigger, ui, and summary fields", () => {
		assert.deepEqual(parsePolicyPatch({ enabled: 1 }), {
			ok: false,
			error: "Invalid enabled: expected literal true or false",
		});
		assert.deepEqual(parsePolicyPatch({ trigger: { minTokens: "1.5" } }), {
			ok: false,
			error: "Invalid trigger.minTokens: expected base-10 non-negative integer",
		});
		assert.deepEqual(parsePolicyPatch({ ui: { quiet: "yes" } }), {
			ok: false,
			error: "Invalid ui.quiet: expected literal true or false",
		});
		assert.deepEqual(parsePolicyPatch({ summary: { thinkingLevel: "max" } }), {
			ok: false,
			error: "Invalid summary.thinkingLevel: expected one of: off, low, medium, high",
		});
	});

	it("rejects an empty models array", () => {
		assert.deepEqual(parsePolicyPatch({ models: [] }), {
			ok: false,
			error: "Invalid models: models array must not be empty",
		});
	});

	it('rejects a model object without a "model" field', () => {
		assert.deepEqual(parsePolicyPatch({ models: [{ thinkingLevel: "low" }] }), {
			ok: false,
			error: 'Invalid models: model entry missing required "model" field',
		});
	});

	it("rejects invalid model selector formats in models", () => {
		for (const model of ["gpt-4", "openai /gpt-4", " openai/gpt-4 ", "openai/"]) {
			assert.deepEqual(parsePolicyPatch({ models: [model] }), {
				ok: false,
				error: "Invalid models: expected model selector provider/modelId",
			});
		}
	});

	it("rejects invalid preservationInstruction values", () => {
		assert.deepEqual(parsePolicyPatch({ summary: { preservationInstruction: 123 } }), {
			ok: false,
			error: "Invalid summary.preservationInstruction: expected instruction string",
		});
		assert.deepEqual(parsePolicyPatch({ summary: { preservationInstruction: " keep " } }), {
			ok: false,
			error: "Invalid summary.preservationInstruction: expected instruction string without surrounding whitespace",
		});
	});

	it("rejects invalid summaryRetention values", () => {
		assert.deepEqual(parsePolicyPatch({ summaryRetention: { mode: "ratio", value: 20 } }), {
			ok: false,
			error: 'Invalid summaryRetention: mode must be "tokens" or "percent"',
		});
		assert.deepEqual(parsePolicyPatch({ summaryRetention: { mode: "tokens", value: "2.5" } }), {
			ok: false,
			error: "Invalid summaryRetention: tokens mode value: expected base-10 non-negative integer",
		});
		assert.deepEqual(parsePolicyPatch({ summaryRetention: { mode: "percent", value: 120 } }), {
			ok: false,
			error: "Invalid summaryRetention: percent mode value: expected percent in [0,100]",
		});
	});

	it('rejects profiles missing the required "match" field', () => {
		assert.deepEqual(parsePolicyPatch({ profiles: { fast: { trigger: { minTokens: 10 } } } }), {
			ok: false,
			error: 'profiles.fast: missing required "match" field',
		});
	});

	it("rejects profiles with unknown keys", () => {
		assert.deepEqual(parsePolicyPatch({ profiles: { fast: { match: "openai/gpt-4", extra: true } } }), {
			ok: false,
			error: "profiles.fast: unknown key: extra",
		});
	});

	it("rejects invalid profile summaryRetention values", () => {
		assert.deepEqual(
			parsePolicyPatch({
				profiles: {
					fast: {
						match: "openai/gpt-4",
						summaryRetention: { mode: "percent", value: -1 },
					},
				},
			}),
			{
				ok: false,
				error: "profiles.fast.summaryRetention: percent mode value: expected percent in [0,100]",
			},
		);
	});
});

describe("parseModelSelector", () => {
	it("accepts valid provider/model selectors", () => {
		assert.deepEqual(parseModelSelector("openai/gpt-4"), { ok: true, value: "openai/gpt-4" });
		assert.deepEqual(parseModelSelector("anthropic/claude-3-opus"), {
			ok: true,
			value: "anthropic/claude-3-opus",
		});
	});

	it("rejects malformed selectors, non-string input, and whitespace-padded strings", () => {
		for (const selector of [
			"gpt-4",
			"/gpt-4",
			"openai/",
			"open ai/gpt-4",
			"openai/gpt 4",
			" openai/gpt-4",
			"openai/gpt-4 ",
			123,
		]) {
			assert.deepEqual(parseModelSelector(selector), {
				ok: false,
				error: "expected model selector provider/modelId",
			});
		}
	});
});

// ---------------------------------------------------------------------------
// Additional branch coverage for uncovered paths
// ---------------------------------------------------------------------------

describe("parsePolicyPatch — additional branches", () => {
	it("rejects non-integer number for trigger.maxTokens", () => {
		const result = parsePolicyPatch({ trigger: { maxTokens: 100.5 } });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.error.includes("non-negative integer"), `got: ${result.error}`);
	});

	it("rejects negative number for trigger.maxTokens", () => {
		const result = parsePolicyPatch({ trigger: { maxTokens: -5 } });
		assert.equal(result.ok, false);
	});

	it("rejects non-numeric string for trigger.maxTokens", () => {
		const result = parsePolicyPatch({ trigger: { trigger: { maxTokens: "abc" } } });
		assert.equal(result.ok, false);
	});

	it("rejects builtinSkipMarginPercent above 100", () => {
		const result = parsePolicyPatch({ trigger: { builtinSkipMarginPercent: 101 } });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.error.includes("[0,100]"), `got: ${result.error}`);
	});

	it("rejects builtinSkipMarginPercent below 0", () => {
		const result = parsePolicyPatch({ trigger: { builtinSkipMarginPercent: -1 } });
		assert.equal(result.ok, false);
	});

	it("parses builtinSkipMarginPercent from string", () => {
		const result = parsePolicyPatch({ trigger: { builtinSkipMarginPercent: "50" } });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.trigger?.builtinSkipMarginPercent, 50);
	});

	it("rejects empty string for trigger.maxTokens (parseNumberLike)", () => {
		const result = parsePolicyPatch({ trigger: { maxTokens: "" } });
		assert.equal(result.ok, false);
	});

	it("rejects non-numeric string for trigger.cooldownMs", () => {
		const result = parsePolicyPatch({ trigger: { cooldownMs: "not-a-number" } });
		assert.equal(result.ok, false);
	});

	it("rejects empty ui.name", () => {
		const result = parsePolicyPatch({ ui: { name: "" } });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.error.includes("non-empty"), `got: ${result.error}`);
	});

	it("rejects ui.name with surrounding whitespace", () => {
		const result = parsePolicyPatch({ ui: { name: " my-status " } });
		assert.equal(result.ok, false);
	});

	it("rejects summary.thinkingLevel other than off/low/medium/high", () => {
		const result = parsePolicyPatch({ summary: { thinkingLevel: "xhigh" } });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.error.includes("off, low, medium, high"), `got: ${result.error}`);
	});

	it("accepts summary.thinkingLevel=off", () => {
		const result = parsePolicyPatch({ summary: { thinkingLevel: "off" } });
		assert.equal(result.ok, true);
	});

	it("accepts summary.thinkingLevel=low", () => {
		const result = parsePolicyPatch({ summary: { thinkingLevel: "low" } });
		assert.equal(result.ok, true);
	});

	it("rejects summary.preservationInstruction with surrounding whitespace", () => {
		const result = parsePolicyPatch({ summary: { preservationInstruction: "  text  " } });
		assert.equal(result.ok, false);
	});

	it("rejects non-string summary.preservationInstruction", () => {
		const result = parsePolicyPatch({ summary: { preservationInstruction: 42 } });
		assert.equal(result.ok, false);
	});

	it("rejects non-object summaryRetention", () => {
		const result = parsePolicyPatch({ summaryRetention: "tokens" });
		assert.equal(result.ok, false);
	});

	it("rejects summaryRetention with unknown mode", () => {
		const result = parsePolicyPatch({ summaryRetention: { mode: "count", value: 5 } });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.error.includes("tokens"), `got: ${result.error}`);
	});

	it("rejects summaryRetention missing value field", () => {
		const result = parsePolicyPatch({ summaryRetention: { mode: "tokens" } });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.error.includes("value"), `got: ${result.error}`);
	});

	it("rejects summaryRetention with unknown key", () => {
		const result = parsePolicyPatch({ summaryRetention: { mode: "tokens", value: 5000, extra: "bad" } });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.error.includes("unknown key"), `got: ${result.error}`);
	});

	it("rejects summaryRetention tokens mode with negative value", () => {
		const result = parsePolicyPatch({ summaryRetention: { mode: "tokens", value: -1 } });
		assert.equal(result.ok, false);
	});

	it("rejects summaryRetention percent mode with value > 100", () => {
		const result = parsePolicyPatch({ summaryRetention: { mode: "percent", value: 200 } });
		assert.equal(result.ok, false);
	});

	it("rejects non-array models", () => {
		const result = parsePolicyPatch({ models: "openai/gpt-4" });
		assert.equal(result.ok, false);
	});

	it("rejects empty models array", () => {
		const result = parsePolicyPatch({ models: [] });
		assert.equal(result.ok, false);
	});

	it("rejects model entry that is not string or object", () => {
		const result = parsePolicyPatch({ models: [42] });
		assert.equal(result.ok, false);
	});

	it("rejects model entry object missing 'model' field", () => {
		const result = parsePolicyPatch({ models: [{ thinkingLevel: "low" }] });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.error.includes("model"), `got: ${result.error}`);
	});

	it("rejects model entry with unknown key", () => {
		const result = parsePolicyPatch({ models: [{ model: "openai/gpt-4", badKey: "oops" }] });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.error.includes("unknown key"), `got: ${result.error}`);
	});

	it("rejects model entry with invalid thinkingLevel", () => {
		const result = parsePolicyPatch({ models: [{ model: "openai/gpt-4", thinkingLevel: "extreme" }] });
		assert.equal(result.ok, false);
	});

	it("rejects model entry with invalid preservationInstruction", () => {
		const result = parsePolicyPatch({ models: [{ model: "openai/gpt-4", preservationInstruction: 99 }] });
		assert.equal(result.ok, false);
	});

	it("parses model entry with thinkingLevel and preservationInstruction", () => {
		const result = parsePolicyPatch({ models: [{ model: "openai/gpt-4", thinkingLevel: "high", preservationInstruction: "Keep errors." }] });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.models?.[0]?.thinkingLevel, "high");
	});

	it("parseBooleanLiteral rejects non-boolean non-string values", () => {
		const result = parsePolicyPatch({ ui: { quiet: 1 } });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.error.includes("true or false"), `got: ${result.error}`);
	});

	it("parseNumberLike rejects non-finite string (NaN)", () => {
		const result = parsePolicyPatch({ trigger: { maxTokens: "NaN" } });
		assert.equal(result.ok, false);
	});

	it("rejects non-object input to parsePolicyPatch", () => {
		assert.deepEqual(parsePolicyPatch("bad"), { ok: false, error: "Policy patch must be an object" });
		assert.deepEqual(parsePolicyPatch(null), { ok: false, error: "Policy patch must be an object" });
		assert.deepEqual(parsePolicyPatch([]), { ok: false, error: "Policy patch must be an object" });
	});

	it("rejects unknown top-level key", () => {
		const result = parsePolicyPatch({ unknownKey: true });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.error.toLowerCase().includes("unknown"), `got: ${result.error}`);
	});
});

describe("parsePolicyPatch — profile branches", () => {
	it("rejects non-object profiles value", () => {
		const result = parsePolicyPatch({ profiles: "bad" });
		assert.equal(result.ok, false);
	});

	it("rejects profile with non-object trigger section", () => {
		const result = parsePolicyPatch({
			profiles: { fast: { match: "openai/gpt-4", trigger: "bad" } },
		});
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.error.includes("trigger"), `got: ${result.error}`);
	});

	it("rejects profile with invalid trigger key", () => {
		const result = parsePolicyPatch({
			profiles: { fast: { match: "openai/gpt-4", trigger: { unknownTriggerKey: 5 } } },
		});
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.error.includes("unknown"), `got: ${result.error}`);
	});

	it("rejects profile with invalid trigger value", () => {
		const result = parsePolicyPatch({
			profiles: { fast: { match: "openai/gpt-4", trigger: { maxTokens: -1 } } },
		});
		assert.equal(result.ok, false);
	});

	it("parses profile with trigger section", () => {
		const result = parsePolicyPatch({
			profiles: { fast: { match: "openai/gpt-4", trigger: { maxTokens: 50000 } } },
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.profiles?.['fast']?.trigger?.maxTokens, 50000);
	});

	it("parses profile with summary override", () => {
		const result = parsePolicyPatch({
			profiles: { fast: { match: "openai/gpt-4", summary: { thinkingLevel: "low" } } },
		});
		assert.equal(result.ok, true);
	});

	it("rejects profile summary with invalid thinkingLevel", () => {
		const result = parsePolicyPatch({
			profiles: { fast: { match: "openai/gpt-4", summary: { thinkingLevel: "extreme" } } },
		});
		assert.equal(result.ok, false);
	});

	it("rejects profile summary with invalid preservationInstruction", () => {
		const result = parsePolicyPatch({
			profiles: { fast: { match: "openai/gpt-4", summary: { preservationInstruction: 42 } } },
		});
		assert.equal(result.ok, false);
	});

	it("rejects profile summary with unknown key", () => {
		const result = parsePolicyPatch({
			profiles: { fast: { match: "openai/gpt-4", summary: { badKey: "oops" } } },
		});
		assert.equal(result.ok, false);
	});

	it("parses profile with template", () => {
		const result = parsePolicyPatch({
			profiles: { fast: { match: "openai/gpt-4", template: "~/.pi/templates/fast.md" } },
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.profiles?.['fast']?.template, "~/.pi/templates/fast.md");
	});

	it("rejects profile template with surrounding whitespace", () => {
		const result = parsePolicyPatch({
			profiles: { fast: { match: "openai/gpt-4", template: " bad " } },
		});
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.error.includes("template"), `got: ${result.error}`);
	});

	it("rejects profile template that is empty", () => {
		const result = parsePolicyPatch({
			profiles: { fast: { match: "openai/gpt-4", template: "" } },
		});
		assert.equal(result.ok, false);
	});

	it("parses profile with updateTemplate", () => {
		const result = parsePolicyPatch({
			profiles: { fast: { match: "openai/gpt-4", updateTemplate: "~/.pi/templates/update.md" } },
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.profiles?.['fast']?.updateTemplate, "~/.pi/templates/update.md");
	});

	it("rejects profile updateTemplate with surrounding whitespace", () => {
		const result = parsePolicyPatch({
			profiles: { fast: { match: "openai/gpt-4", updateTemplate: " bad " } },
		});
		assert.equal(result.ok, false);
	});

	it("rejects non-object profile value", () => {
		const result = parsePolicyPatch({ profiles: { fast: "bad" } });
		assert.equal(result.ok, false);
	});

	it("rejects profile missing match field", () => {
		const result = parsePolicyPatch({ profiles: { fast: { trigger: { maxTokens: 5000 } } } });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.error.includes("match"), `got: ${result.error}`);
	});
});
