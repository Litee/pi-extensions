import { describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	RECALL_OBSERVATION_TOOL_NAME,
	formatRecallCallForTui,
	formatRecallRenderedResultForTui,
	formatRecallResultForTui,
	formatRecallHeaderForTui,
	recallObservationTool,
	registerRecallTool,
	type RecallObservationToolDetails,
	type RecallSourceEntryDetails,
} from "../src/tools/recall-observation.js";
import {
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2ObservationEntry,
	rawMessage,
	reflection,
	reflectionsRecordedEntry,
	type TestEntry,
} from "./fixtures/session.js";

function fakeCtx(entries: TestEntry[]) {
	const getBranch = vi.fn(() => entries);
	const getEntries = vi.fn(() => {
		throw new Error("recall tool must not use getEntries");
	});
	return { ctx: { sessionManager: { getBranch, getEntries } }, getBranch, getEntries };
}

async function execute(id: string, entries: TestEntry[]) {
	const { ctx, getBranch, getEntries } = fakeCtx(entries);
	const result = await recallObservationTool.execute("tool-1", { id }, undefined, undefined, ctx as unknown as ExtensionContext) as AgentToolResult<RecallObservationToolDetails>;
	const text = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
	return { result, text, getBranch, getEntries };
}

describe("V3 recall tool", () => {
	it("keeps the public tool name and TUI call rendering", () => {
		const pi = { registerTool: vi.fn() };
		registerRecallTool(pi as unknown as ExtensionAPI);

		expect(RECALL_OBSERVATION_TOOL_NAME).toBe("recall");
		expect(recallObservationTool.name).toBe("recall");
		expect(recallObservationTool.label).toBe("Recall memory evidence");
		expect(formatRecallCallForTui("aaaaaaaaaaaa")).toBe("recall aaaaaaaaaaaa");
		expect(pi.registerTool).toHaveBeenCalledWith(recallObservationTool);
	});

	it("renders active observation source evidence", async () => {
		const obs = observation("aaaaaaaaaaaa", { content: "User likes tea.", sourceEntryIds: ["raw-1"] });
		const entries = [rawMessage("raw-1", "I like tea."), observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" })];

		const { result, text, getBranch, getEntries } = await execute("aaaaaaaaaaaa", entries);

		expect(getBranch).toHaveBeenCalledOnce();
		expect(getEntries).not.toHaveBeenCalled();
		expect(result.details.status).toBe("ok");
		expect(result.details.matches[0]!.observation.status).toBe("active");
		expect(text).toContain("I like tea.");
		expect(formatRecallRenderedResultForTui(result, false)).toContain("✓ observation");
	});

	it("renders dropped observations as recallable but dropped", async () => {
		const obs = observation("aaaaaaaaaaaa", { content: "User likes tea.", sourceEntryIds: ["raw-1"] });
		const entries = [
			rawMessage("raw-1", "I like tea."),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-obs" }),
		];

		const { result, text } = await execute("aaaaaaaaaaaa", entries);
		const tui = formatRecallRenderedResultForTui(result, false);

		expect(result.details.matches[0]!.observation.status).toBe("dropped");
		expect(text).toContain("dropped from active memory but remains recallable");
		expect(tui).toContain("[dropped]");
	});

	it("renders reflection recall with supporting observations and sources", async () => {
		const obs = observation("aaaaaaaaaaaa", { content: "User likes tea.", sourceEntryIds: ["raw-1"] });
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "User likes tea." });
		const entries = [
			rawMessage("raw-1", "I like tea."),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "om-obs" }),
		];

		const { result, text } = await execute("eeeeeeeeeeee", entries);

		expect(result.details.status).toBe("ok");
		expect(result.details.reflections).toHaveLength(1);
		expect(result.details.observations).toHaveLength(1);
		expect(text).toContain("Reflections:");
		expect(text).toContain("[eeeeeeeeeeee] User likes tea.");
		expect(text).toContain("Observations:");
		expect(text).toContain("Sources:");
		expect(text).toContain("I like tea.");
	});

	it("reports missing sources as partial", async () => {
		const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["missing-raw"] });
		const entries = [observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "om-obs" })];

		const { result, text } = await execute("aaaaaaaaaaaa", entries);

		expect(result.details.status).toBe("partial");
		expect(result.details.missingSourceEntryIds).toEqual(["missing-raw"]);
		expect(text).toContain("missing: missing-raw");
	});

	it("reports invalid ids without reading the branch", async () => {
		const { result, text, getBranch } = await execute("not-valid", []);

		expect(result.details.status).toBe("invalid_id");
		expect(text).toContain("Memory id must be 12 lowercase hex characters");
		expect(getBranch).not.toHaveBeenCalled();
	});

	it("reports not found and ignores old V2 memory", async () => {
		const entries = [oldV2ObservationEntry("v2-obs")];

		const { result, text } = await execute("aaaaaaaaaaaa", entries);

		expect(result.details.status).toBe("not_found");
		expect(text).toContain("No observation or reflection with id aaaaaaaaaaaa was found");
	});
});

describe("recall TUI rendering helpers", () => {
	// Local stand-ins for the non-exported detail types in recall-observation.ts.
	type LocalObservationDetails = {
		id: string;
		content: string;
		timestamp: string;
		relevance: "low" | "medium" | "high" | "critical";
		status?: "active" | "dropped";
	};
	type LocalReflectionDetails = {
		id: string;
		content: string;
		supportingObservationIds: string[];
		reflectionIndex: number;
	};
	type LocalMatchDetails = {
		status: "active" | "dropped" | "source_unavailable" | "no_source";
		observationEntryId: string;
		observationRecordIndex: number;
		observation: LocalObservationDetails;
		sourceEntryIds?: string[];
		sourceEntries?: RecallSourceEntryDetails[];
		missingSourceEntryIds?: string[];
		nonSourceEntryIds?: string[];
	};

	function makeDetails(overrides: Partial<RecallObservationToolDetails> = {}): RecallObservationToolDetails {
		return {
			status: "ok",
			memoryId: "aaaaaaaaaaaa",
			observationId: "aaaaaaaaaaaa",
			collision: false,
			partial: false,
			reflections: [],
			directObservationMatches: [],
			observations: [],
			matches: [],
			sourceEntries: [],
			unavailableSupportingObservations: [],
			missingSourceEntryIds: [],
			nonSourceEntryIds: [],
			...overrides,
		};
	}

	function reflectionDetails(id: string, content: string): LocalReflectionDetails {
		return { id, content, supportingObservationIds: [], reflectionIndex: 0 };
	}

	function observationDetails(id: string, status?: "active" | "dropped"): LocalObservationDetails {
		return {
			id,
			content: "An observation",
			timestamp: "2026-01-01T00:00:00Z",
			relevance: "high",
			...(status !== undefined ? { status } : {}),
		};
	}

	function matchFor(obs: LocalObservationDetails): LocalMatchDetails {
		return {
			status: "active",
			observationEntryId: "obs-entry-1",
			observationRecordIndex: 0,
			observation: obs,
		};
	}

	describe("formatRecallHeaderForTui", () => {
		it("renders failure status for invalid_id", () => {
			const details = makeDetails({ status: "invalid_id" });
			expect(formatRecallHeaderForTui(details)).toBe("× failure");
		});

		it("renders failure status for not_found", () => {
			const details = makeDetails({ status: "not_found" });
			expect(formatRecallHeaderForTui(details)).toBe("× failure");
		});

		it("renders success with reflections, observations, sources, and tokens", () => {
			const details = makeDetails({
				status: "ok",
				reflections: [reflectionDetails("rrrrrrrrrrr1", "A fact")],
				observations: [matchFor(observationDetails("aaaaaaaaaaaa"))],
				matches: [matchFor(observationDetails("aaaaaaaaaaaa"))],
				sourceEntries: [{ id: "raw-1", origin: "User", timestamp: "2026-01-01 00:00", tokens: 10, qualifiers: [] }],
			});
			const header = formatRecallHeaderForTui(details);
			expect(header).toContain("✓ success");
			expect(header).toContain("1 reflection");
			expect(header).toContain("1 observation");
			expect(header).toContain("1 source");
			expect(header).toContain("~10 tokens");
		});

		it("renders plural correctly for multiple items", () => {
			const details = makeDetails({
				status: "ok",
				reflections: [reflectionDetails("rrrrrrrrrrr1", "A"), reflectionDetails("rrrrrrrrrrr2", "B")],
				observations: [matchFor(observationDetails("aaaaaaaaaaaa")), matchFor(observationDetails("bbbbbbbbbbbb"))],
				matches: [matchFor(observationDetails("aaaaaaaaaaaa")), matchFor(observationDetails("bbbbbbbbbbbb"))],
				sourceEntries: [
					{ id: "raw-1", origin: "User", timestamp: "2026-01-01 00:00", tokens: 5, qualifiers: [] },
					{ id: "raw-2", origin: "Assistant", timestamp: "2026-01-01 00:01", tokens: 15, qualifiers: [] },
				],
			});
			const header = formatRecallHeaderForTui(details);
			expect(header).toContain("2 reflections");
			expect(header).toContain("2 observations");
			expect(header).toContain("2 sources");
		});

		it("renders partial status suffix when partial is true and status is not ok", () => {
			const details = makeDetails({
				status: "partial" as RecallObservationToolDetails["status"],
				partial: true,
				reflections: [],
				observations: [],
				matches: [],
				sourceEntries: [],
			});
			expect(formatRecallHeaderForTui(details)).toContain("partial");
		});

		it("omits partial suffix when partial is true but status is ok", () => {
			const details = makeDetails({
				status: "ok",
				partial: true,
				reflections: [],
				observations: [],
				matches: [],
				sourceEntries: [],
			});
			expect(formatRecallHeaderForTui(details)).not.toContain("partial");
		});
	});

	describe("formatRecallResultForTui", () => {
		it("renders raw text result when details is missing", () => {
			const result: AgentToolResult<RecallObservationToolDetails> = {
				content: [{ type: "text", text: "raw text output" }],
				details: undefined as never,
			};
			expect(formatRecallResultForTui(result, false)).toBe("raw text output");
		});

		it("renders empty recall when no content and no details", () => {
			const result: AgentToolResult<RecallObservationToolDetails> = {
				content: [],
				details: undefined as never,
			};
			expect(formatRecallResultForTui(result, false)).toBe("recall");
		});

		it("renders observation-only rows with source metadata", () => {
			const details = makeDetails({
				status: "ok",
				observations: [matchFor(observationDetails("aaaaaaaaaaaa"))],
				matches: [
					{
						...matchFor(observationDetails("aaaaaaaaaaaa")),
						sourceEntries: [{ id: "raw-1", origin: "User", timestamp: "2026-01-01 00:00", tokens: 10, qualifiers: [], content: "User said hello" }],
					},
				],
			});
			const result: AgentToolResult<RecallObservationToolDetails> = { content: [], details };
			const rendered = formatRecallResultForTui(result, true);
			expect(rendered).toContain("✓ observation");
			expect(rendered).toContain("✓ source");
			expect(rendered).toContain("User said hello");
		});

		it("renders memory rows with reflections and observations", () => {
			const details = makeDetails({
				status: "ok",
				reflections: [reflectionDetails("rrrrrrrrrrr1", "A reflection")],
				observations: [matchFor(observationDetails("aaaaaaaaaaaa"))],
				sourceEntries: [],
			});
			const result: AgentToolResult<RecallObservationToolDetails> = { content: [], details };
			const rendered = formatRecallResultForTui(result, false);
			expect(rendered).toContain("✓ reflection");
			expect(rendered).toContain("A reflection");
			expect(rendered).toContain("✓ observation");
			expect(rendered).toContain("An observation");
		});

		it("renders dropped observation note", () => {
			const details = makeDetails({
				status: "ok",
				observations: [matchFor(observationDetails("aaaaaaaaaaaa", "dropped"))],
				matches: [matchFor(observationDetails("aaaaaaaaaaaa", "dropped"))],
				sourceEntries: [],
			});
			const result: AgentToolResult<RecallObservationToolDetails> = { content: [], details };
			const rendered = formatRecallResultForTui(result, false);
			expect(rendered).toContain("dropped");
		});

		it("renders collision note", () => {
			const details = makeDetails({
				status: "ok",
				collision: true,
				observations: [matchFor(observationDetails("aaaaaaaaaaaa"))],
				matches: [matchFor(observationDetails("aaaaaaaaaaaa"))],
				sourceEntries: [],
			});
			const result: AgentToolResult<RecallObservationToolDetails> = { content: [], details };
			const rendered = formatRecallResultForTui(result, false);
			expect(rendered).toContain("id collision");
		});

		it("renders missing source note", () => {
			const details = makeDetails({
				status: "ok",
				missingSourceEntryIds: ["missing-raw"],
				observations: [matchFor(observationDetails("aaaaaaaaaaaa"))],
				matches: [matchFor(observationDetails("aaaaaaaaaaaa"))],
				sourceEntries: [],
			});
			const result: AgentToolResult<RecallObservationToolDetails> = { content: [], details };
			const rendered = formatRecallResultForTui(result, false);
			expect(rendered).toContain("missing source");
			expect(rendered).toContain("missing-raw");
		});

		it("renders non-source note", () => {
			const details = makeDetails({
				status: "ok",
				nonSourceEntryIds: ["compaction-1"],
				observations: [matchFor(observationDetails("aaaaaaaaaaaa"))],
				matches: [matchFor(observationDetails("aaaaaaaaaaaa"))],
				sourceEntries: [],
			});
			const result: AgentToolResult<RecallObservationToolDetails> = { content: [], details };
			const rendered = formatRecallResultForTui(result, false);
			expect(rendered).toContain("non-source");
		});

		it("renders unavailable supporting observations note", () => {
			const details = makeDetails({
				status: "ok",
				unavailableSupportingObservations: [{ observationId: "missing-obs" }],
				observations: [],
				matches: [],
				sourceEntries: [],
			});
			const result: AgentToolResult<RecallObservationToolDetails> = { content: [], details };
			const rendered = formatRecallResultForTui(result, false);
			expect(rendered).toContain("missing support");
			expect(rendered).toContain("missing-obs");
		});

		it("renders expanded sources with content when expanded is true", () => {
			const details = makeDetails({
				status: "ok",
				observations: [matchFor(observationDetails("aaaaaaaaaaaa"))],
				matches: [
					{
						...matchFor(observationDetails("aaaaaaaaaaaa")),
						sourceEntries: [{ id: "raw-1", origin: "User", timestamp: "2026-01-01 00:00", tokens: 10, qualifiers: [], content: "User said hello" }],
					},
				],
			});
			const result: AgentToolResult<RecallObservationToolDetails> = { content: [], details };
			const renderedExpanded = formatRecallResultForTui(result, true);
			const renderedCollapsed = formatRecallResultForTui(result, false);
			expect(renderedExpanded).toContain("User said hello");
			expect(renderedCollapsed).toContain("(Ctrl+O to expand)");
		});

		it("renders invalid_id note", () => {
			const details = makeDetails({ status: "invalid_id", memoryId: "not-hex" });
			const result: AgentToolResult<RecallObservationToolDetails> = { content: [], details };
			const rendered = formatRecallResultForTui(result, false);
			expect(rendered).toContain("invalid id");
			expect(rendered).toContain("not-hex");
		});

		it("renders not_found note", () => {
			const details = makeDetails({ status: "not_found", memoryId: "aaaaaaaaaaaa" });
			const result: AgentToolResult<RecallObservationToolDetails> = { content: [], details };
			const rendered = formatRecallResultForTui(result, false);
			expect(rendered).toContain("not found");
		});

		it("renders unavailable evidence note when sources are empty but observations exist", () => {
			const details = makeDetails({
				status: "ok",
				observations: [matchFor(observationDetails("aaaaaaaaaaaa"))],
				matches: [matchFor(observationDetails("aaaaaaaaaaaa"))],
				sourceEntries: [],
			});
			const result: AgentToolResult<RecallObservationToolDetails> = { content: [], details };
			const rendered = formatRecallResultForTui(result, false);
			expect(rendered).toContain("unavailable evidence");
		});
	});

	describe("formatRecallRenderedResultForTui", () => {
		it("renders header and body together", () => {
			const details = makeDetails({
				status: "ok",
				reflections: [reflectionDetails("rrrrrrrrrrr1", "A fact")],
				observations: [matchFor(observationDetails("aaaaaaaaaaaa"))],
				matches: [matchFor(observationDetails("aaaaaaaaaaaa"))],
				sourceEntries: [{ id: "raw-1", origin: "User", timestamp: "2026-01-01 00:00", tokens: 10, qualifiers: [] }],
			});
			const result: AgentToolResult<RecallObservationToolDetails> = { content: [], details };
			const rendered = formatRecallRenderedResultForTui(result, false);
			expect(rendered).toContain("✓ success");
			expect(rendered).toContain("✓ reflection");
			expect(rendered).toContain("✓ observation");
		});

		it("renders body only when details is missing", () => {
			const result: AgentToolResult<RecallObservationToolDetails> = {
				content: [{ type: "text", text: "body text" }],
				details: undefined as never,
			};
			expect(formatRecallRenderedResultForTui(result, false)).toContain("body text");
		});

		it("renders header only when body is empty", () => {
			const details = makeDetails({ status: "invalid_id" });
			const result: AgentToolResult<RecallObservationToolDetails> = { content: [], details };
			const rendered = formatRecallRenderedResultForTui(result, false);
			expect(rendered).toContain("× failure");
		});
	});

	describe("formatRecallCallForTui", () => {
		it("renders with id", () => {
			expect(formatRecallCallForTui("aaaaaaaaaaaa")).toBe("recall aaaaaaaaaaaa");
		});

		it("renders with ellipsis for undefined id", () => {
			expect(formatRecallCallForTui(undefined)).toBe("recall ...");
		});
	});
});
