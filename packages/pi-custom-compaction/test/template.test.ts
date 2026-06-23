import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type CompactionPolicy } from "../src/policy/types.js";
import { buildSummaryPrompt, discoverTemplate, resolveSummarySettings } from "../src/summary/template.js";

describe("discoverTemplate", () => {
	let cwd = "";

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-custom-compaction-template-"));
	});

	afterEach(() => {
		if (cwd) rmSync(cwd, { recursive: true, force: true });
	});

	it("returns an empty object when no template files exist", (t) => {
		const globalDefault = join(homedir(), ".pi", "agent", "compaction-template.md");
		if (existsSync(globalDefault)) {
			t.skip(`global default template exists at ${globalDefault}, cannot assert empty fallback`);
			return;
		}

		assert.deepEqual(discoverTemplate(cwd, undefined), {});
	});

	it("returns template content from project .pi/compaction-template.md", () => {
		const path = resolve(cwd, ".pi", "compaction-template.md");
		mkdirSync(resolve(cwd, ".pi"), { recursive: true });
		writeFileSync(path, "  # Template\nBody  ", "utf8");

		const result = discoverTemplate(cwd, undefined);
		assert.equal(result.template, "# Template\nBody");
		assert.equal(result.resolvedPath, path);

		const globalUpdate = join(homedir(), ".pi", "agent", "compaction-template-update.md");
		if (existsSync(globalUpdate)) {
			assert.equal(result.updateResolvedPath, globalUpdate);
			assert.equal(Boolean(result.updateTemplate || result.updateFallbackReason), true);
		}
	});

	it("returns fallbackReason when template file exists but is empty", () => {
		const path = resolve(cwd, ".pi", "compaction-template.md");
		mkdirSync(resolve(cwd, ".pi"), { recursive: true });
		writeFileSync(path, "   ", "utf8");

		assert.deepEqual(discoverTemplate(cwd, undefined), {
			resolvedPath: path,
			fallbackReason: "template file is empty",
		});
	});

	it("returns updateTemplate when update template file exists", () => {
		const templatePath = resolve(cwd, ".pi", "compaction-template.md");
		const updatePath = resolve(cwd, ".pi", "compaction-template-update.md");
		mkdirSync(resolve(cwd, ".pi"), { recursive: true });
		writeFileSync(templatePath, "Base template", "utf8");
		writeFileSync(updatePath, "Update template", "utf8");

		assert.deepEqual(discoverTemplate(cwd, undefined), {
			template: "Base template",
			resolvedPath: templatePath,
			updateTemplate: "Update template",
			updateResolvedPath: updatePath,
		});
	});

	it("uses explicit template paths when provided", () => {
		const templatePath = join(cwd, "custom-initial.md");
		const updatePath = join(cwd, "custom-update.md");
		writeFileSync(templatePath, "Explicit initial", "utf8");
		writeFileSync(updatePath, "Explicit update", "utf8");

		const result = discoverTemplate(cwd, undefined, {
			template: templatePath,
			updateTemplate: updatePath,
		});
		assert.equal(result.template, "Explicit initial");
		assert.equal(result.resolvedPath, templatePath);
		assert.equal(result.updateTemplate, "Explicit update");
		assert.equal(result.updateResolvedPath, updatePath);
	});

	it("returns fallbackReason when explicit template path does not exist", () => {
		const missingPath = join(cwd, "nonexistent.md");
		const result = discoverTemplate(cwd, undefined, { template: missingPath });
		assert.equal(result.template, undefined);
		assert.equal(result.resolvedPath, missingPath);
		assert.equal(result.fallbackReason, "file not found");
	});
});

describe("resolveSummarySettings", () => {
	const policy: CompactionPolicy = {
		...DEFAULT_POLICY,
		trigger: { ...DEFAULT_POLICY.trigger },
		models: [...DEFAULT_POLICY.models],
		ui: { ...DEFAULT_POLICY.ui },
		summary: { thinkingLevel: "low", preservationInstruction: "Policy preserve instruction." },
	};

	it("uses model entry overrides when present", () => {
		const result = resolveSummarySettings(policy, {
			model: "openai/gpt-4",
			thinkingLevel: "high",
			preservationInstruction: "Entry preserve instruction.",
		});
		assert.deepEqual(result, {
			thinkingLevel: "high",
			preservationInstruction: "Entry preserve instruction.",
		});
	});

	it("falls back to policy defaults when model entry has no overrides", () => {
		const result = resolveSummarySettings(policy, { model: "openai/gpt-4" });
		assert.deepEqual(result, {
			thinkingLevel: "low",
			preservationInstruction: "Policy preserve instruction.",
		});
	});
});

describe("buildSummaryPrompt", () => {
	it("includes the base template in output", () => {
		const result = buildSummaryPrompt("BASE_TEMPLATE", undefined, undefined, undefined, "Keep exact paths.");
		assert.match(result, /Use this EXACT format:/);
		assert.match(result, /BASE_TEMPLATE/);
	});

	it("uses updateTemplate when previous summary exists and updateTemplate is provided", () => {
		const result = buildSummaryPrompt(
			"BASE_TEMPLATE",
			"UPDATE_TEMPLATE",
			"Old summary",
			undefined,
			"Keep exact paths.",
		);
		assert.match(result, /UPDATE_TEMPLATE/);
		assert.equal(result.includes("BASE_TEMPLATE"), false);
		assert.match(result, /Update the existing structured summary with new information/);
	});

	it("includes custom instructions when provided", () => {
		const result = buildSummaryPrompt(
			"BASE_TEMPLATE",
			undefined,
			undefined,
			"Focus on failures only.",
			"Keep exact paths.",
		);
		assert.match(result, /Additional focus: Focus on failures only\./);
	});

	it("includes preservation instruction in the prompt", () => {
		const result = buildSummaryPrompt("BASE_TEMPLATE", undefined, undefined, undefined, "Preserve exact errors.");
		assert.match(result, /Preserve exact errors\./);
	});
});

// ---------------------------------------------------------------------------
// Additional branch coverage
// ---------------------------------------------------------------------------
describe("discoverTemplate — updateTemplate error path", () => {
	it("sets updateFallbackReason when explicit updateTemplate path does not exist", () => {
		const t = mkdtempSync(join(tmpdir(), "template-update-err-"));
		const templatePath = join(t, "initial.md");
		writeFileSync(templatePath, "Initial template", "utf8");
		const missingUpdatePath = join(t, "nonexistent-update.md");

		const result = discoverTemplate(t, undefined, {
			template: templatePath,
			updateTemplate: missingUpdatePath,
		});
		assert.equal(result.template, "Initial template");
		assert.ok(result.updateFallbackReason?.includes("not found"), `expected 'not found' in: ${result.updateFallbackReason}`);
		assert.equal(result.updateResolvedPath, missingUpdatePath);
	});
});

describe("buildSummaryPrompt — additional branches", () => {
	it("uses base template when previousSummary exists but no updateTemplate", () => {
		const result = buildSummaryPrompt("BASE_TEMPLATE", undefined, "previous summary", undefined, "");
		// With previousSummary but no updateTemplate → uses base template
		expect(result).toContain("BASE_TEMPLATE");
		expect(result).toContain("previous-summary");
	});

	it("does not append preservationInstruction when it is empty string", () => {
		const result = buildSummaryPrompt("TEMPLATE", undefined, undefined, undefined, "");
		// Empty preservationInstruction → no extra line appended
		expect(result).toContain("TEMPLATE");
		expect(result).not.toContain("undefined");
	});
});

describe("discoverTemplate — findTemplate path with error (empty update template)", () => {
	it("sets updateFallbackReason when auto-found update template is empty", () => {
		const t = mkdtempSync(join(tmpdir(), "template-empty-update-"));
		// Create the main template and an EMPTY update template
		const piDir = join(t, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "compaction-template.md"), "Main template content", "utf8");
		writeFileSync(join(piDir, "compaction-template-update.md"), "", "utf8"); // empty!

		const result = discoverTemplate(t, undefined);
		assert.equal(result.template, "Main template content");
		assert.ok(result.updateFallbackReason?.includes("empty"), `Expected 'empty' in: ${result.updateFallbackReason}`);
		assert.equal(result.updateResolvedPath, join(piDir, "compaction-template-update.md"));

		rmSync(t, { recursive: true, force: true });
	});
});

describe("discoverTemplate — tilde path expansion in explicit template", () => {
	it("expands ~/ prefix to homedir for explicit template path", () => {
		// We can only test this non-destructively by using a real path that doesn't exist
		// to verify the expansion logic runs (it will return error for missing file).
		const result = discoverTemplate("/tmp", undefined, { template: "~/nonexistent-test-path.md" });
		// Should have resolved the path (even if file not found)
		assert.ok(result.resolvedPath?.includes(homedir()), `Expected homedir expansion, got: ${result.resolvedPath}`);
		assert.ok(result.fallbackReason?.includes("not found") ?? result.fallbackReason !== undefined);
	});
});

// ---------------------------------------------------------------------------
// discoverTemplate — profileName branch (lines 41-45 in template.ts)
// ---------------------------------------------------------------------------

describe("discoverTemplate — named profile lookup", () => {
	let cwd = "";

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-cc-template-profile-"));
	});

	afterEach(() => {
		if (cwd) rmSync(cwd, { recursive: true, force: true });
	});

	it("uses the project-level profile template when profileName is provided and file exists", () => {
		// TEMPLATE_DIR = "compaction-templates", profileSuffix = "" (empty for main template)
		// profileFile = "myprofile.md"
		const profileDir = resolve(cwd, ".pi", "compaction-templates");
		mkdirSync(profileDir, { recursive: true });
		const profilePath = join(profileDir, "myprofile.md");
		writeFileSync(profilePath, "Profile template content", "utf8");

		const result = discoverTemplate(cwd, "myprofile");
		assert.equal(result.template, "Profile template content");
		assert.equal(result.resolvedPath, profilePath);
	});

	it("falls through to default template when profile file does not exist", (t) => {
		// Profile file does NOT exist → should fall back to default template
		// (no project .pi/compaction-template.md either → empty result)
		const globalDefault = join(homedir(), ".pi", "agent", "compaction-template.md");
		if (existsSync(globalDefault)) {
			t.skip("global default template exists, cannot assert empty fallback");
			return;
		}

		const result = discoverTemplate(cwd, "nonexistent-profile");
		// Template is not found; result has no template key (or fallbackReason)
		assert.ok(result.template === undefined || result.fallbackReason !== undefined || Object.keys(result).length === 0,
			`Expected no template in result, got: ${JSON.stringify(result)}`);
	});
});
