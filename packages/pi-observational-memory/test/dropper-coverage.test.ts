import { describe, expect, it } from "vitest";

import {
	coverageTierForObservation,
	observationToDropperLine,
	reflectionCoverageMap,
	reflectionCoverageTierForCount,
	summarizeCoverageByRelevance,
	summarizeCoverageByRelevanceForIds,
	summarizeCoverageTransitionsByRelevance,
} from "../src/agents/dropper/agent.js";
import { observation, reflection } from "./fixtures/session.js";

describe("V3 dropper reflection coverage helpers", () => {
	it("maps support counts to deterministic coverage tiers", () => {
		expect(reflectionCoverageTierForCount(0)).toBe("none");
		expect(reflectionCoverageTierForCount(1)).toBe("partial");
		expect(reflectionCoverageTierForCount(2)).toBe("strong");
		expect(reflectionCoverageTierForCount(10)).toBe("strong");
	});

	it("computes none, partial, and strong coverage from reflection support ids", () => {
		const none = observation("aaaaaaaaaaaa");
		const partial = observation("bbbbbbbbbbbb");
		const strong = observation("cccccccccccc");
		const coverage = reflectionCoverageMap([none, partial, strong], [
			reflection("rrrrrrrrrrr1", ["bbbbbbbbbbbb", "cccccccccccc"]),
			reflection("rrrrrrrrrrr2", ["cccccccccccc", "cccccccccccc"]),
		]);

		expect(coverage.get("aaaaaaaaaaaa")).toBe("none");
		expect(coverage.get("bbbbbbbbbbbb")).toBe("partial");
		expect(coverage.get("cccccccccccc")).toBe("strong");
	});

	it("summarizes coverage counts and token totals by relevance", () => {
		const observations = [
			observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 3 }),
			observation("bbbbbbbbbbbb", { relevance: "critical", tokenCount: 5 }),
			observation("cccccccccccc", { relevance: "critical", tokenCount: 7 }),
		];
		const coverage = reflectionCoverageMap(observations, [
			reflection("rrrrrrrrrrr1", ["bbbbbbbbbbbb", "cccccccccccc"]),
			reflection("rrrrrrrrrrr2", ["cccccccccccc"]),
		]);

		expect(summarizeCoverageByRelevance(observations, coverage)).toMatchObject({
			low: { none: { count: 1, tokens: 3 } },
			critical: {
				partial: { count: 1, tokens: 5 },
				strong: { count: 1, tokens: 7 },
			},
		});
	});

	it("summarizes coverage transitions by relevance without exposing ids", () => {
		const observations = [
			observation("aaaaaaaaaaaa", { relevance: "high", tokenCount: 3 }),
			observation("bbbbbbbbbbbb", { relevance: "critical", tokenCount: 5 }),
			observation("cccccccccccc", { relevance: "critical", tokenCount: 7 }),
		];
		const before = reflectionCoverageMap(observations, [
			reflection("rrrrrrrrrrr1", ["bbbbbbbbbbbb"]),
		]);
		const after = reflectionCoverageMap(observations, [
			reflection("rrrrrrrrrrr1", ["bbbbbbbbbbbb"]),
			reflection("rrrrrrrrrrr2", ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]),
			reflection("rrrrrrrrrrr3", ["cccccccccccc"]),
		]);

		expect(summarizeCoverageTransitionsByRelevance(observations, before, after)).toEqual({
			low: {},
			medium: {},
			high: { "none->partial": { count: 1, tokens: 3 } },
			critical: {
				"partial->strong": { count: 1, tokens: 5 },
				"none->strong": { count: 1, tokens: 7 },
			},
		});
	});

	it("renders model-facing observation lines with coverage evidence only", () => {
		const line = observationToDropperLine(
			observation("aaaaaaaaaaaa", { relevance: "critical", content: "Important fact" }),
			"strong",
		);

		expect(line).toContain("[aaaaaaaaaaaa]");
		expect(line).toContain("[critical]");
		expect(line).toContain("[coverage: strong]");
		expect(line).toContain("Important fact");
		expect(line).not.toContain("drop-priority");
		expect(line).not.toContain("drop-resistance");
	});

	it("renders observation lines for all coverage tiers", () => {
		const obs = observation("aaaaaaaaaaaa", { relevance: "low", content: "Low fact" });
		expect(observationToDropperLine(obs, "none")).toContain("[coverage: none]");
		expect(observationToDropperLine(obs, "partial")).toContain("[coverage: partial]");
		expect(observationToDropperLine(obs, "strong")).toContain("[coverage: strong]");
	});

	it("summarizes coverage transitions for equal before/after (no transition)", () => {
		const observations = [observation("aaaaaaaaaaaa", { relevance: "high", tokenCount: 5 })];
		const coverage = reflectionCoverageMap(observations, []);

		const transitions = summarizeCoverageTransitionsByRelevance(observations, coverage, coverage);

		expect(transitions.high).toEqual({});
		expect(transitions.low).toEqual({});
		expect(transitions.medium).toEqual({});
		expect(transitions.critical).toEqual({});
	});

	it("summarizes coverage transitions for none->partial", () => {
		const observations = [observation("aaaaaaaaaaaa", { relevance: "medium", tokenCount: 3 })];
		const before = reflectionCoverageMap(observations, []);
		const after = reflectionCoverageMap(observations, [reflection("rrrrrrrrrrr1", ["aaaaaaaaaaaa"])]);

		const transitions = summarizeCoverageTransitionsByRelevance(observations, before, after);

		expect(transitions.medium).toEqual({ "none->partial": { count: 1, tokens: 3 } });
	});

	it("summarizes coverage transitions for partial->strong", () => {
		const observations = [observation("aaaaaaaaaaaa", { relevance: "critical", tokenCount: 7 })];
		const before = reflectionCoverageMap(observations, [reflection("rrrrrrrrrrr1", ["aaaaaaaaaaaa"])]);
		const after = reflectionCoverageMap(observations, [
			reflection("rrrrrrrrrrr1", ["aaaaaaaaaaaa"]),
			reflection("rrrrrrrrrrr2", ["aaaaaaaaaaaa"]),
		]);

		const transitions = summarizeCoverageTransitionsByRelevance(observations, before, after);

		expect(transitions.critical).toEqual({ "partial->strong": { count: 1, tokens: 7 } });
	});

	it("summarizes coverage transitions for strong->none (coverage removed)", () => {
		const observations = [observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 4 })];
		const before = reflectionCoverageMap(observations, [
			reflection("rrrrrrrrrrr1", ["aaaaaaaaaaaa"]),
			reflection("rrrrrrrrrrr2", ["aaaaaaaaaaaa"]),
		]);
		const after = reflectionCoverageMap(observations, []);

		const transitions = summarizeCoverageTransitionsByRelevance(observations, before, after);

		expect(transitions.low).toEqual({ "strong->none": { count: 1, tokens: 4 } });
	});

	it("summarizes mixed transitions across multiple observations", () => {
		const obs1 = observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 3 });
		const obs2 = observation("bbbbbbbbbbbb", { relevance: "high", tokenCount: 5 });
		const obs3 = observation("cccccccccccc", { relevance: "critical", tokenCount: 7 });
		const observations = [obs1, obs2, obs3];
		const before = reflectionCoverageMap(observations, [
			reflection("rrrrrrrrrrr1", ["bbbbbbbbbbbb"]),
		]);
		const after = reflectionCoverageMap(observations, [
			reflection("rrrrrrrrrrr1", ["bbbbbbbbbbbb"]),
			reflection("rrrrrrrrrrr2", ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]),
			reflection("rrrrrrrrrrr3", ["cccccccccccc"]),
		]);

		const transitions = summarizeCoverageTransitionsByRelevance(observations, before, after);

		expect(transitions.low).toEqual({ "none->partial": { count: 1, tokens: 3 } });
		expect(transitions.high).toEqual({ "partial->strong": { count: 1, tokens: 5 } });
		expect(transitions.critical).toEqual({ "none->partial": { count: 1, tokens: 7 } });
	});

	it("handles empty observations list", () => {
		const transitions = summarizeCoverageTransitionsByRelevance([], new Map(), new Map());
		expect(transitions.low).toEqual({});
		expect(transitions.medium).toEqual({});
		expect(transitions.high).toEqual({});
		expect(transitions.critical).toEqual({});
	});

	it("coverageTierForObservation returns tier from map or defaults to none", () => {
		const obs = observation("aaaaaaaaaaaa");
		const coverage = reflectionCoverageMap([obs], []);
		expect(coverageTierForObservation(obs, coverage)).toBe("none");

		const coverage2 = reflectionCoverageMap([obs], [reflection("rrrrrrrrrrr1", ["aaaaaaaaaaaa"])]);
		expect(coverageTierForObservation(obs, coverage2)).toBe("partial");
	});

	it("summarizeCoverageByRelevanceForIds filters by provided ids", () => {
		const obs1 = observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 3 });
		const obs2 = observation("bbbbbbbbbbbb", { relevance: "critical", tokenCount: 5 });
		const observations = [obs1, obs2];
		const coverage = reflectionCoverageMap(observations, []);

		const summary = summarizeCoverageByRelevanceForIds(["aaaaaaaaaaaa"], observations, coverage);

		expect(summary.low.none.count).toBe(1);
		expect(summary.low.none.tokens).toBe(3);
		expect(summary.critical.none.count).toBe(0);
	});

	it("summarizeCoverageByRelevanceForIds handles ids not in observations list", () => {
		const obs1 = observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 3 });
		const observations = [obs1];
		const coverage = reflectionCoverageMap(observations, []);

		const summary = summarizeCoverageByRelevanceForIds(["missing", "aaaaaaaaaaaa"], observations, coverage);

		expect(summary.low.none.count).toBe(1);
		expect(summary.low.none.tokens).toBe(3);
	});
});
