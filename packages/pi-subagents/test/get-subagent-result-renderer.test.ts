import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import subagentsExtension from "../src/index.js";

// ── Minimal pi stub ───────────────────────────────────────────────────────────

type AnyTool = {
  name: string;
  execute: (...args: unknown[]) => unknown;
  renderResult?: (...args: unknown[]) => unknown;
};

function makePi() {
  const tools = new Map<string, AnyTool>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: AnyTool) => { tools.set(tool.name, tool); }),
    registerCommand: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const THEME = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };

/** Extract the raw string stored inside a Text instance. */
function str(textInstance: unknown): string {
  return (textInstance as { text: string }).text;
}

function makeResult(text: string) {
  return text
    ? { content: [{ type: "text", text }] }
    : { content: [] as Array<{ type: string; text: string }> };
}

const FULL_TEXT = [
  "Agent: abc123-uuid",
  "Type: andrey-scout | Status: completed | Tool uses: 1 | 55.3k token | Duration: 27.9s",
  "Description: Quick test agent",
  "",
  "The packages/ directory contains 22 pi-extensions.",
].join("\n");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("get_subagent_result renderResult", () => {
  let renderResult: (result: unknown, opts: { expanded: boolean }, theme: typeof THEME) => unknown;

  beforeAll(() => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const tool = tools.get("get_subagent_result");
    if (!tool?.renderResult) throw new Error("get_subagent_result not registered or missing renderResult");
    renderResult = (result, opts, theme) => tool.renderResult!(result, opts, theme);
  });

  it("empty content → returns empty string", () => {
    expect(str(renderResult(makeResult(""), { expanded: false }, THEME))).toBe("");
  });

  it("collapsed, completed: ✓ icon, summary parts, expand hint", () => {
    const out = str(renderResult(makeResult(FULL_TEXT), { expanded: false }, THEME));
    expect(out).toContain("<success>✓</success>");
    expect(out).toContain("<dim>andrey-scout</dim>");
    expect(out).toContain("<dim>completed</dim>");
    expect(out).toContain("<dim>Quick test agent</dim>");
    expect(out).toContain("<muted>  … ctrl-o to expand</muted>");
  });

  it("collapsed, error: ✗ icon", () => {
    const text = [
      "Agent: abc123-uuid",
      "Type: andrey-scout | Status: error | Tool uses: 0 | 1.0k token | Duration: 2.1s",
      "Description: Failing agent",
    ].join("\n");
    const out = str(renderResult(makeResult(text), { expanded: false }, THEME));
    expect(out).toContain("<error>✗</error>");
    expect(out).toContain("<muted>  … ctrl-o to expand</muted>");
  });

  it("collapsed, running: ○ icon", () => {
    const text = [
      "Agent: abc123-uuid",
      "Type: andrey-scout | Status: running | Tool uses: 3 | 10.0k token | Duration: 5.2s",
      "Description: Working agent",
    ].join("\n");
    const out = str(renderResult(makeResult(text), { expanded: false }, THEME));
    expect(out).toContain("<dim>○</dim>");
    expect(out).toContain("<muted>  … ctrl-o to expand</muted>");
  });

  it("expanded: each line dim-styled with two-space indent, no expand hint", () => {
    const out = str(renderResult(makeResult(FULL_TEXT), { expanded: true }, THEME));
    for (const line of out.split("\n")) {
      expect(line).toMatch(/^<dim>  .*<\/dim>$/);
    }
    expect(out).not.toContain("ctrl-o");
  });

  it("collapsed, malformed header: falls back gracefully, still shows expand hint", () => {
    const out = str(renderResult(makeResult("Just some plain text"), { expanded: false }, THEME));
    expect(out).toContain("<muted>  … ctrl-o to expand</muted>");
  });
});
