/**
 * Renderer tests — pure formatting plus a smoke test that the TUI renderer
 * produces a Box without throwing.
 */
import { Box } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { createMessageRenderer, formatEventLine } from "../src/render.js";

describe("formatEventLine", () => {
	it("formats a normal event with name + kind + message", () => {
		expect(
			formatEventLine({
				customType: "pi-sandboxed-workflows:event",
				content: "Plan ready",
				details: { name: "implement", kind: "planner-done" },
			}),
		).toBe("[workflow:implement] planner-done — Plan ready");
	});

	it("falls back to '?' when name or kind is missing", () => {
		expect(
			formatEventLine({
				customType: "pi-sandboxed-workflows:event",
				content: "x",
				details: {},
			}),
		).toBe("[workflow:?] ? — x");
	});

	it("falls back to '?' when details is undefined", () => {
		expect(
			formatEventLine({
				customType: "pi-sandboxed-workflows:event",
				content: "y",
			}),
		).toBe("[workflow:?] ? — y");
	});
});

describe("createMessageRenderer", () => {
	// Identity-coloring stub theme. We only care that the renderer wires
	// theme calls without throwing; the colored output strings flow through
	// pi-tui to the TTY in the real environment.
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
	};

	it("returns a Box (NOT a string) so pi can render it as a TUI node", () => {
		const render = createMessageRenderer();
		const out = render(
			{
				customType: "pi-sandboxed-workflows:event",
				content: "hello",
				details: { name: "hello", kind: "started" },
			},
			{ expanded: false },
			theme,
		);
		expect(out).toBeInstanceOf(Box);
	});

	it("works for an error event with a stack trace in details when expanded", () => {
		const render = createMessageRenderer();
		const out = render(
			{
				customType: "pi-sandboxed-workflows:event",
				content: "boom",
				details: {
					name: "impl",
					kind: "error",
					stack: "Error: boom\n  at /tmp/x.ts:1:1",
					runId: "r-1",
				},
			},
			{ expanded: true },
			theme,
		);
		expect(out).toBeInstanceOf(Box);
	});
});
