import { describe, expect, it } from "vitest";
import { isValidInstanceId, validateInstanceId, InstanceIdError } from "../src/instanceId.js";

describe("isValidInstanceId", () => {
	it("accepts a standard 8-hex i- id", () => {
		expect(isValidInstanceId("i-1234abcd")).toBe(true);
	});

	it("accepts a 17-hex i- id", () => {
		expect(isValidInstanceId("i-0a1b2c3d4e5f67890")).toBe(true);
	});

	it("rejects uppercase", () => {
		expect(isValidInstanceId("i-1234ABCD")).toBe(false);
	});

	it("rejects too short (< 8 hex chars)", () => {
		expect(isValidInstanceId("i-1234abc")).toBe(false);
	});

	it("rejects too long (> 17 hex chars)", () => {
		expect(isValidInstanceId("i-0a1b2c3d4e5f678901")).toBe(false);
	});

	it("rejects non-hex chars", () => {
		expect(isValidInstanceId("i-1234abcg")).toBe(false);
	});

	it("rejects missing i- prefix", () => {
		expect(isValidInstanceId("1234abcd56789012")).toBe(false);
	});

	it("rejects empty string", () => {
		expect(isValidInstanceId("")).toBe(false);
	});

	it("rejects null/undefined gracefully when cast to unknown", () => {
		expect(isValidInstanceId(null)).toBe(false);
	});
});

describe("validateInstanceId", () => {
	it("returns the id unchanged when valid", () => {
		expect(validateInstanceId("i-0a1b2c3d4e5f67890")).toBe("i-0a1b2c3d4e5f67890");
	});

	it("throws InstanceIdError for invalid ids", () => {
		expect(() => validateInstanceId("bad-id")).toThrowError(InstanceIdError);
		expect(() => validateInstanceId("bad-id")).toThrowError(/invalid/i);
	});
});
