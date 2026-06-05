/**
 * Unit tests for structuredOutput.ts — pure, no I/O.
 */
import { describe, expect, it } from "vitest";

import {
	PI_SW_RESULT_TAG,
	PI_SW_BLOCKER_TAG,
	TagNotFoundError,
	ValidationError,
	SchemaCompileError,
	extractTaggedJson,
	extractBlocker,
	buildStructuredOutputInstruction,
	injectTagFooter,
	validateJson,
} from "../src/structuredOutput.js";

// ── injectTagFooter ──────────────────────────────────────────────────────────

describe("injectTagFooter", () => {
	const schema = { type: "object", properties: { x: { type: "string" } } };

	it("appends a footer containing the tag literal and schema JSON", () => {
		const result = injectTagFooter("Do the thing.", PI_SW_RESULT_TAG, schema);
		expect(result).toContain(`<${PI_SW_RESULT_TAG}>`);
		expect(result).toContain(`</${PI_SW_RESULT_TAG}>`);
		expect(result).toContain(JSON.stringify(schema, null, 2));
	});

	it("is idempotent — returns prompt unchanged when tag already present", () => {
		const withTag = `Do the thing and put answer in <${PI_SW_RESULT_TAG}> here.`;
		expect(injectTagFooter(withTag, PI_SW_RESULT_TAG, schema)).toBe(withTag);
	});

	it("includes the framework comment marker in the footer", () => {
		const result = injectTagFooter("prompt", PI_SW_RESULT_TAG, schema);
		expect(result).toContain("pi-sandboxed-workflows: structured output");
	});

	it("works with a custom tag", () => {
		const result = injectTagFooter("prompt", "my_tag", schema);
		expect(result).toContain("<my_tag>...");
		expect(result).toContain("</my_tag>");
	});

	it("includes additionalProperties:false in the footer schema body", () => {
		const s = {
			type: "object",
			properties: { name: { type: "string" } },
			additionalProperties: false,
		};
		const result = injectTagFooter("p", PI_SW_RESULT_TAG, s);
		expect(result).toContain('"additionalProperties": false');
	});
});

// ── extractTaggedJson ─────────────────────────────────────────────────────────

describe("extractTaggedJson", () => {
	it("extracts inner text from a simple tag block", () => {
		const stdout = `<${PI_SW_RESULT_TAG}>{"a":1}</${PI_SW_RESULT_TAG}>`;
		expect(extractTaggedJson(stdout, PI_SW_RESULT_TAG)).toBe('{"a":1}');
	});

	it("returns the LAST tag block when there are multiple", () => {
		const stdout =
			`<${PI_SW_RESULT_TAG}>first</${PI_SW_RESULT_TAG}>\n` +
			`some text\n` +
			`<${PI_SW_RESULT_TAG}>second</${PI_SW_RESULT_TAG}>`;
		expect(extractTaggedJson(stdout, PI_SW_RESULT_TAG)).toBe("second");
	});

	it("handles multi-line content inside the tag", () => {
		const json = '{\n  "a": 1,\n  "b": 2\n}';
		const stdout = `prefix\n<${PI_SW_RESULT_TAG}>\n${json}\n</${PI_SW_RESULT_TAG}>`;
		expect(extractTaggedJson(stdout, PI_SW_RESULT_TAG)).toBe(json);
	});

	it("trims surrounding whitespace from the inner content", () => {
		const stdout = `<${PI_SW_RESULT_TAG}>  {"x":1}  </${PI_SW_RESULT_TAG}>`;
		expect(extractTaggedJson(stdout, PI_SW_RESULT_TAG)).toBe('{"x":1}');
	});

	it("throws TagNotFoundError when the tag is absent", () => {
		expect(() => extractTaggedJson("no tag here", PI_SW_RESULT_TAG)).toThrow(
			TagNotFoundError,
		);
	});

	it("throws TagNotFoundError with the tag name in the message", () => {
		try {
			extractTaggedJson("nothing", "my_tag");
		} catch (e) {
			expect(e).toBeInstanceOf(TagNotFoundError);
			expect((e as Error).message).toContain("my_tag");
		}
	});
});

// ── validateJson ────────────────────────────────────────────────────────────────────────

describe("validateJson", () => {
	it("passes when data matches schema", () => {
		const schema = {
			type: "object",
			required: ["name"],
			properties: { name: { type: "string" } },
		};
		expect(() => validateJson({ name: "alice" }, schema)).not.toThrow();
	});

	it("throws ValidationError when a required field is missing", () => {
		const schema = {
			type: "object",
			required: ["name"],
			properties: { name: { type: "string" } },
		};
		expect(() => validateJson({}, schema)).toThrow(ValidationError);
	});

	it("includes instancePath in the error message", () => {
		const schema = {
			type: "object",
			required: ["age"],
			properties: { age: { type: "number" } },
		};
		try {
			validateJson({ age: "not-a-number" }, schema);
		} catch (e) {
			expect(e).toBeInstanceOf(ValidationError);
			expect((e as Error).message).toMatch(/\/age|must be number/i);
		}
	});

	it("reports additionalProperties violations", () => {
		const schema = {
			type: "object",
			properties: { x: { type: "string" } },
			additionalProperties: false,
		};
		expect(() =>
			validateJson({ x: "ok", extra: "bad" }, schema),
		).toThrow(ValidationError);
	});

	it("throws ValidationError (not Error) so caller can instanceof-check", () => {
		expect(() => validateJson("wrong-type", { type: "object" })).toThrow(
			ValidationError,
		);
	});
});

// ── extractBlocker ─────────────────────────────────────────────────────────

describe("extractBlocker", () => {
	it("returns the trimmed reason when the blocker tag is present", () => {
		const stdout = `some text\n<${PI_SW_BLOCKER_TAG}>  bash not available  </${PI_SW_BLOCKER_TAG}>\nmore`;
		expect(extractBlocker(stdout)).toBe("bash not available");
	});

	it("returns undefined when the blocker tag is absent", () => {
		expect(extractBlocker("no blocker here")).toBeUndefined();
	});

	it("returns undefined for an empty string", () => {
		expect(extractBlocker("")).toBeUndefined();
	});
});

// ── validateJson — SchemaCompileError ──────────────────────────────────────

describe("validateJson — SchemaCompileError (bad schema)", () => {
	it("throws SchemaCompileError when given a non-object schema (runtime cast)", () => {
		// AJV throws synchronously when given a non-object/non-boolean schema.
		// At runtime a caller could pass a bogus value despite the TypeScript type.
		expect(() =>
			validateJson({}, 42 as unknown as Record<string, unknown>),
		).toThrow(SchemaCompileError);
	});

	it("SchemaCompileError.name is 'SchemaCompileError'", () => {
		try {
			validateJson({}, null as unknown as Record<string, unknown>);
		} catch (e) {
			expect(e).toBeInstanceOf(SchemaCompileError);
			expect((e as Error).name).toBe("SchemaCompileError");
		}
	});

	it("SchemaCompileError message contains the AJV error detail", () => {
		try {
			validateJson({}, 42 as unknown as Record<string, unknown>);
		} catch (e) {
			expect((e as Error).message).toMatch(/schema/i);
		}
	});

	it("does NOT throw SchemaCompileError for a well-formed schema", () => {
		expect(() =>
			validateJson(
				{ name: "alice" },
				{ type: "object", properties: { name: { type: "string" } } },
			),
		).not.toThrow(SchemaCompileError);
	});
});

// ── buildStructuredOutputInstruction ──────────────────────────────────

describe("buildStructuredOutputInstruction", () => {
	it("mentions the blocker tag in the instruction", () => {
		const instr = buildStructuredOutputInstruction("pi_sw_result", { type: "object" });
		expect(instr).toContain("pi_sw_blocker");
	});
});
