import { describe, expect, it } from "vitest";

import { Validator } from "./validation.js";
import {
	COLOR_BLAZING,
	COLOR_FAST,
	COLOR_MEDIUM,
	COLOR_SLOW,
	COUNT_STRATEGY,
	DISPLAY_MODE,
	END_TPS_BEHAVIOR,
	SLIDING_WINDOW,
	TPS_THRESHOLD_BLAZING,
	TPS_THRESHOLD_FAST,
	TPS_THRESHOLD_MEDIUM,
	TPS_THRESHOLD_SLOW,
	USE_PROVIDER_TOKENS,
} from "./defaults.js";

describe("Validator", () => {
	describe("isValidHex", () => {
		it("accepts valid 24-bit hex colors", () => {
			expect(Validator.isValidHex("#00ff88")).toBe(true);
			expect(Validator.isValidHex("#FF00FF")).toBe(true);
			expect(Validator.isValidHex("#abcdef")).toBe(true);
			expect(Validator.isValidHex("#123456")).toBe(true);
		});

		it("rejects invalid hex colors", () => {
			expect(Validator.isValidHex("ff00ff")).toBe(false);
			expect(Validator.isValidHex("#ff00f")).toBe(false);
			expect(Validator.isValidHex("#ff00ffg")).toBe(false);
			expect(Validator.isValidHex("")).toBe(false);
			expect(Validator.isValidHex("#123")).toBe(false);
			expect(Validator.isValidHex(null as unknown as string)).toBe(false);
			expect(Validator.isValidHex(undefined as unknown as string)).toBe(false);
		});
	});

	describe("validate — correct values", () => {
		it("returns the config as-is when all values are valid", () => {
			const config = {
				display: "full" as const,
				countStrategy: "direct" as const,
				useProviderTokens: true,
				slidingWindow: 2000,
				endTpsBehavior: "last" as const,
				tpsSlow: TPS_THRESHOLD_SLOW,
				tpsMedium: TPS_THRESHOLD_MEDIUM,
				tpsFast: TPS_THRESHOLD_FAST,
				tpsBlazing: TPS_THRESHOLD_BLAZING,
				colorSlow: COLOR_SLOW,
				colorMedium: COLOR_MEDIUM,
				colorFast: COLOR_FAST,
				colorBlazing: COLOR_BLAZING,
			};
			const { config: validated, errors } = Validator.validate(config);
			expect(errors).toEqual([]);
			expect(validated).toStrictEqual(config);
		});
	});

	describe("validate — display mode correction", () => {
		it("defaults invalid display mode", () => {
			const config = {
				display: "invalid" as unknown as "tps",
				countStrategy: "direct" as const,
				useProviderTokens: false,
				slidingWindow: 1000,
				endTpsBehavior: "average" as const,
				tpsSlow: TPS_THRESHOLD_SLOW,
				tpsMedium: TPS_THRESHOLD_MEDIUM,
				tpsFast: TPS_THRESHOLD_FAST,
				tpsBlazing: TPS_THRESHOLD_BLAZING,
				colorSlow: COLOR_SLOW,
				colorMedium: COLOR_MEDIUM,
				colorFast: COLOR_FAST,
				colorBlazing: COLOR_BLAZING,
			};
			const { config: validated, errors } = Validator.validate(config);
			expect(validated.display).toBe(DISPLAY_MODE);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("Invalid display");
		});

		it("accepts all valid display modes", () => {
			for (const mode of ["tps", "ttft", "stats", "full"] as const) {
				const config = {
					display: mode,
					countStrategy: "direct" as const,
					useProviderTokens: false,
					slidingWindow: 1000,
					endTpsBehavior: "average" as const,
					tpsSlow: TPS_THRESHOLD_SLOW,
					tpsMedium: TPS_THRESHOLD_MEDIUM,
					tpsFast: TPS_THRESHOLD_FAST,
					tpsBlazing: TPS_THRESHOLD_BLAZING,
					colorSlow: COLOR_SLOW,
					colorMedium: COLOR_MEDIUM,
					colorFast: COLOR_FAST,
					colorBlazing: COLOR_BLAZING,
				};
				const { errors } = Validator.validate(config);
				expect(errors).toEqual([]);
			}
		});
	});

	describe("validate — count strategy correction", () => {
		it("defaults invalid count strategy", () => {
			const config = {
				display: "tps" as const,
				countStrategy: "invalid" as unknown as "direct",
				useProviderTokens: false,
				slidingWindow: 1000,
				endTpsBehavior: "average" as const,
				tpsSlow: TPS_THRESHOLD_SLOW,
				tpsMedium: TPS_THRESHOLD_MEDIUM,
				tpsFast: TPS_THRESHOLD_FAST,
				tpsBlazing: TPS_THRESHOLD_BLAZING,
				colorSlow: COLOR_SLOW,
				colorMedium: COLOR_MEDIUM,
				colorFast: COLOR_FAST,
				colorBlazing: COLOR_BLAZING,
			};
			const { config: validated, errors } = Validator.validate(config);
			expect(validated.countStrategy).toBe(COUNT_STRATEGY);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("Invalid countStrategy");
		});
	});

	describe("validate — useProviderTokens correction", () => {
		it("defaults non-boolean useProviderTokens", () => {
			const config = {
				display: "tps" as const,
				countStrategy: "direct" as const,
				useProviderTokens: "yes" as unknown as boolean,
				slidingWindow: 1000,
				endTpsBehavior: "average" as const,
				tpsSlow: TPS_THRESHOLD_SLOW,
				tpsMedium: TPS_THRESHOLD_MEDIUM,
				tpsFast: TPS_THRESHOLD_FAST,
				tpsBlazing: TPS_THRESHOLD_BLAZING,
				colorSlow: COLOR_SLOW,
				colorMedium: COLOR_MEDIUM,
				colorFast: COLOR_FAST,
				colorBlazing: COLOR_BLAZING,
			};
			const { config: validated, errors } = Validator.validate(config);
			expect(validated.useProviderTokens).toBe(USE_PROVIDER_TOKENS);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("Invalid useProviderTokens");
		});

		it("accepts boolean true", () => {
			const config = {
				display: "tps" as const,
				countStrategy: "direct" as const,
				useProviderTokens: true,
				slidingWindow: 1000,
				endTpsBehavior: "average" as const,
				tpsSlow: TPS_THRESHOLD_SLOW,
				tpsMedium: TPS_THRESHOLD_MEDIUM,
				tpsFast: TPS_THRESHOLD_FAST,
				tpsBlazing: TPS_THRESHOLD_BLAZING,
				colorSlow: COLOR_SLOW,
				colorMedium: COLOR_MEDIUM,
				colorFast: COLOR_FAST,
				colorBlazing: COLOR_BLAZING,
			};
			const { config: validated } = Validator.validate(config);
			expect(validated.useProviderTokens).toBe(true);
		});
	});

	describe("validate — sliding window correction", () => {
		it("defaults slidingWindow below minimum", () => {
			const config = {
				display: "tps" as const,
				countStrategy: "direct" as const,
				useProviderTokens: false,
				slidingWindow: 50,
				endTpsBehavior: "average" as const,
				tpsSlow: TPS_THRESHOLD_SLOW,
				tpsMedium: TPS_THRESHOLD_MEDIUM,
				tpsFast: TPS_THRESHOLD_FAST,
				tpsBlazing: TPS_THRESHOLD_BLAZING,
				colorSlow: COLOR_SLOW,
				colorMedium: COLOR_MEDIUM,
				colorFast: COLOR_FAST,
				colorBlazing: COLOR_BLAZING,
			};
			const { config: validated, errors } = Validator.validate(config);
			expect(validated.slidingWindow).toBe(SLIDING_WINDOW);
			expect(errors).toHaveLength(1);
		});

		it("defaults slidingWindow above maximum", () => {
			const config = {
				display: "tps" as const,
				countStrategy: "direct" as const,
				useProviderTokens: false,
				slidingWindow: 60_000,
				endTpsBehavior: "average" as const,
				tpsSlow: TPS_THRESHOLD_SLOW,
				tpsMedium: TPS_THRESHOLD_MEDIUM,
				tpsFast: TPS_THRESHOLD_FAST,
				tpsBlazing: TPS_THRESHOLD_BLAZING,
				colorSlow: COLOR_SLOW,
				colorMedium: COLOR_MEDIUM,
				colorFast: COLOR_FAST,
				colorBlazing: COLOR_BLAZING,
			};
			const { config: validated, errors } = Validator.validate(config);
			expect(validated.slidingWindow).toBe(SLIDING_WINDOW);
			expect(errors).toHaveLength(1);
		});

		it("defaults non-numeric slidingWindow", () => {
			const config = {
				display: "tps" as const,
				countStrategy: "direct" as const,
				useProviderTokens: false,
				slidingWindow: "fast" as unknown as number,
				endTpsBehavior: "average" as const,
				tpsSlow: TPS_THRESHOLD_SLOW,
				tpsMedium: TPS_THRESHOLD_MEDIUM,
				tpsFast: TPS_THRESHOLD_FAST,
				tpsBlazing: TPS_THRESHOLD_BLAZING,
				colorSlow: COLOR_SLOW,
				colorMedium: COLOR_MEDIUM,
				colorFast: COLOR_FAST,
				colorBlazing: COLOR_BLAZING,
			};
			const { config: validated, errors } = Validator.validate(config);
			expect(validated.slidingWindow).toBe(SLIDING_WINDOW);
			expect(errors).toHaveLength(1);
		});

		it("accepts slidingWindow at boundaries", () => {
			// Minimum
			let config = {
				display: "tps" as const,
				countStrategy: "direct" as const,
				useProviderTokens: false,
				slidingWindow: 100,
				endTpsBehavior: "average" as const,
				tpsSlow: TPS_THRESHOLD_SLOW,
				tpsMedium: TPS_THRESHOLD_MEDIUM,
				tpsFast: TPS_THRESHOLD_FAST,
				tpsBlazing: TPS_THRESHOLD_BLAZING,
				colorSlow: COLOR_SLOW,
				colorMedium: COLOR_MEDIUM,
				colorFast: COLOR_FAST,
				colorBlazing: COLOR_BLAZING,
			};
			let { errors } = Validator.validate(config);
			expect(errors).toEqual([]);

			// Maximum
			config = {
				...config,
				slidingWindow: 30_000,
			};
			({ errors } = Validator.validate(config));
			expect(errors).toEqual([]);
		});
	});

	describe("validate — end TPS behavior correction", () => {
		it("defaults invalid endTpsBehavior", () => {
			const config = {
				display: "tps" as const,
				countStrategy: "direct" as const,
				useProviderTokens: false,
				slidingWindow: 1000,
				endTpsBehavior: "never" as unknown as "average",
				tpsSlow: TPS_THRESHOLD_SLOW,
				tpsMedium: TPS_THRESHOLD_MEDIUM,
				tpsFast: TPS_THRESHOLD_FAST,
				tpsBlazing: TPS_THRESHOLD_BLAZING,
				colorSlow: COLOR_SLOW,
				colorMedium: COLOR_MEDIUM,
				colorFast: COLOR_FAST,
				colorBlazing: COLOR_BLAZING,
			};
			const { config: validated, errors } = Validator.validate(config);
			expect(validated.endTpsBehavior).toBe(END_TPS_BEHAVIOR);
			expect(errors).toHaveLength(1);
		});
	});

	describe("validate — threshold order", () => {
		it("rejects non-ascending thresholds", () => {
			const config = {
				display: "tps" as const,
				countStrategy: "direct" as const,
				useProviderTokens: false,
				slidingWindow: 1000,
				endTpsBehavior: "average" as const,
				tpsSlow: 100,
				tpsMedium: 50,
				tpsFast: 30,
				tpsBlazing: 20,
				colorSlow: COLOR_SLOW,
				colorMedium: COLOR_MEDIUM,
				colorFast: COLOR_FAST,
				colorBlazing: COLOR_BLAZING,
			};
			const { errors } = Validator.validate(config);
			expect(errors.some((e: string) => e.includes("ascending order"))).toBe(true);
		});

		it("accepts strictly ascending thresholds", () => {
			const config = {
				display: "tps" as const,
				countStrategy: "direct" as const,
				useProviderTokens: false,
				slidingWindow: 1000,
				endTpsBehavior: "average" as const,
				tpsSlow: 0,
				tpsMedium: 15,
				tpsFast: 30,
				tpsBlazing: 45,
				colorSlow: COLOR_SLOW,
				colorMedium: COLOR_MEDIUM,
				colorFast: COLOR_FAST,
				colorBlazing: COLOR_BLAZING,
			};
			const { errors } = Validator.validate(config);
			expect(errors).toEqual([]);
		});
	});

	describe("validate — color definitions", () => {
		it("rejects invalid colorSlow", () => {
			const config = {
				display: "tps" as const,
				countStrategy: "direct" as const,
				useProviderTokens: false,
				slidingWindow: 1000,
				endTpsBehavior: "average" as const,
				tpsSlow: TPS_THRESHOLD_SLOW,
				tpsMedium: TPS_THRESHOLD_MEDIUM,
				tpsFast: TPS_THRESHOLD_FAST,
				tpsBlazing: TPS_THRESHOLD_BLAZING,
				colorSlow: "red",
				colorMedium: COLOR_MEDIUM,
				colorFast: COLOR_FAST,
				colorBlazing: COLOR_BLAZING,
			};
			const { errors } = Validator.validate(config);
			expect(errors.some((e: string) => e.includes("colorSlow"))).toBe(true);
		});

		it("rejects multiple invalid colors", () => {
			const config = {
				display: "tps" as const,
				countStrategy: "direct" as const,
				useProviderTokens: false,
				slidingWindow: 1000,
				endTpsBehavior: "average" as const,
				tpsSlow: TPS_THRESHOLD_SLOW,
				tpsMedium: TPS_THRESHOLD_MEDIUM,
				tpsFast: TPS_THRESHOLD_FAST,
				tpsBlazing: TPS_THRESHOLD_BLAZING,
				colorSlow: "bad",
				colorMedium: "also-bad",
				colorFast: "#00ff88",
				colorBlazing: "#44ddff",
			};
			const { errors } = Validator.validate(config);
			expect(errors.some((e: string) => e.includes("colorSlow"))).toBe(true);
			expect(errors.some((e: string) => e.includes("colorMedium"))).toBe(true);
		});
	});

	describe("validate — multiple errors", () => {
		it("collects all validation errors", () => {
			const config = {
				display: "invalid" as unknown as "tps",
				countStrategy: "wrong" as unknown as "direct",
				useProviderTokens: "yes" as unknown as boolean,
				slidingWindow: 10,
				endTpsBehavior: "never" as unknown as "average",
				tpsSlow: 100,
				tpsMedium: 50,
				tpsFast: 30,
				tpsBlazing: 20,
				colorSlow: "bad",
				colorMedium: "also-bad",
				colorFast: "wrong",
				colorBlazing: "ugly",
			};
			const { errors } = Validator.validate(config);
			expect(errors.length).toBeGreaterThan(1);
		});
	});
});
