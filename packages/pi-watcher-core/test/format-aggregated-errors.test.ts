import { describe, expect, it } from "vitest";

import {
	formatAggregatedErrorsMessage,
	type AggregatedWatcherError,
} from "../src/format-aggregated-errors.js";

describe("formatAggregatedErrorsMessage", () => {
	it("returns undefined when errors is empty", () => {
		expect(
			formatAggregatedErrorsMessage({
				extension: "code-review-watcher",
				phase: "poll",
				singular: "CR",
				errors: [],
			}),
		).toBeUndefined();
	});

	it("formats a single-error message as '<ext>: <phase> failed for <singular> <id>: <msg>'", () => {
		const msg = formatAggregatedErrorsMessage({
			extension: "code-review-watcher",
			phase: "poll",
			singular: "CR",
			errors: [{ id: "CR-1", error: "request failed" }],
		});
		expect(msg).toBe("code-review-watcher: poll failed for CR CR-1: request failed");
	});

	it("formats a multi-error message as '<ext>: <phase> failed for <N> <plural>: <first msg>'", () => {
		const errors: AggregatedWatcherError[] = [
			{ id: "CR-1", error: "first failure" },
			{ id: "CR-2", error: "second failure" },
			{ id: "CR-3", error: "third failure" },
		];
		const msg = formatAggregatedErrorsMessage({
			extension: "code-review-watcher",
			phase: "poll",
			singular: "CR",
			errors,
		});
		expect(msg).toBe("code-review-watcher: poll failed for 3 CRs: first failure");
	});

	it("defaults plural to '<singular>s'", () => {
		const msg = formatAggregatedErrorsMessage({
			extension: "pipelines-watcher",
			phase: "seed",
			singular: "pipeline",
			errors: [
				{ id: "42", error: "boom" },
				{ id: "43", error: "later boom" },
			],
		});
		expect(msg).toBe("pipelines-watcher: seed failed for 2 pipelines: boom");
	});

	it("uses plural override when provided (e.g. irregular plurals)", () => {
		const msg = formatAggregatedErrorsMessage({
			extension: "ticket-watcher",
			phase: "poll",
			singular: "query",
			plural: "queries",
			errors: [
				{ id: "Q-1", error: "x" },
				{ id: "Q-2", error: "y" },
			],
		});
		expect(msg).toBe("ticket-watcher: poll failed for 2 queries: x");
	});

	it("matches the byte-for-byte phrasing each watcher produced before the refactor", () => {
		// code-review-watcher, poll, 1 error
		expect(
			formatAggregatedErrorsMessage({
				extension: "code-review-watcher",
				phase: "poll",
				singular: "CR",
				errors: [{ id: "CR-7:analyzer", error: "request failed" }],
			}),
		).toBe("code-review-watcher: poll failed for CR CR-7:analyzer: request failed");
		// pipelines-watcher, seed, 2 errors
		expect(
			formatAggregatedErrorsMessage({
				extension: "pipelines-watcher",
				phase: "seed",
				singular: "pipeline",
				errors: [
					{ id: "42", error: "not found" },
					{ id: "43", error: "auth" },
				],
			}),
		).toBe("pipelines-watcher: seed failed for 2 pipelines: not found");
		// ticket-watcher, poll, 1 error
		expect(
			formatAggregatedErrorsMessage({
				extension: "ticket-watcher",
				phase: "poll",
				singular: "ticket",
				errors: [{ id: "V1234567890", error: "throttled" }],
			}),
		).toBe("ticket-watcher: poll failed for ticket V1234567890: throttled");
		// ticket-watcher, seed, 3 errors
		expect(
			formatAggregatedErrorsMessage({
				extension: "ticket-watcher",
				phase: "seed",
				singular: "ticket",
				errors: [
					{ id: "V1", error: "boom" },
					{ id: "V2", error: "boom" },
					{ id: "V3", error: "boom" },
				],
			}),
		).toBe("ticket-watcher: seed failed for 3 tickets: boom");
	});
});
