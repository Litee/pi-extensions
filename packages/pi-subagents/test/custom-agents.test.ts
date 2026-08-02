import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_TOOL_NAMES } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";

describe("loadCustomAgents", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-test-"));

    originalHome = process.env["HOME"];
    originalAgentDir = process.env["PI_CODING_AGENT_DIR"];
    process.env["HOME"] = tmpDir;
    delete process.env["PI_CODING_AGENT_DIR"];
  });

  afterEach(() => {
    if (originalHome == null) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (originalAgentDir == null) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = originalAgentDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgentIn(projectDir: ".agents" | ".pi", name: string, content: string) {
    const dir = join(tmpDir, projectDir, "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), content);
  }

  function writeAgent(name: string, content: string) {
    writeAgentIn(".pi", name, content);
  }

  function writeWorkspaceAgent(name: string, content: string) {
    writeAgentIn(".agents", name, content);
  }

  it("returns empty map when custom agent dirs do not exist", () => {
    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(0);
  });

  it("loads a workspace project agent from .agents/agents", () => {
    writeWorkspaceAgent("reviewer", `---
description: Workspace Reviewer
---

Workspace prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get("reviewer")?.description).toBe("Workspace Reviewer");
    expect(result.get("reviewer")?.systemPrompt).toBe("Workspace prompt.");
    expect(result.get("reviewer")?.source).toBe("project");
  });

  it(".pi/agents overrides .agents/agents on a name clash", () => {
    writeWorkspaceAgent("dupe", `---
description: Workspace Project
---

Workspace prompt.`);
    writeAgent("dupe", `---
description: Pi Project
---

Pi prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get("dupe")?.description).toBe("Pi Project");
    expect(result.get("dupe")?.systemPrompt).toBe("Pi prompt.");
  });

  it("workspace project agents override global agents", () => {
    const globalAgentDir = join(tmpDir, "global-agent-dir");
    process.env["PI_CODING_AGENT_DIR"] = globalAgentDir;
    const globalAgents = join(globalAgentDir, "agents");
    mkdirSync(globalAgents, { recursive: true });
    writeFileSync(join(globalAgents, "dupe.md"), `---
description: Global
---

Global prompt.`);
    writeWorkspaceAgent("dupe", `---
description: Workspace Project
---

Workspace prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get("dupe")?.description).toBe("Workspace Project");
    expect(result.get("dupe")?.systemPrompt).toBe("Workspace prompt.");
  });

  it("loads a basic agent with all frontmatter fields", () => {
    writeAgent("auditor", `---
description: Security Auditor
tools: read, grep, find
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
persist_session: true
output_transcript: false
session_dir: .seams/pi-sessions/seam-plan-reviewer
allowed_subagents: scout, reviewer
prompt_mode: replace
inherit_context: true
run_in_background: true
isolated: true
---

You are a security auditor.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);

    const agent = result.get("auditor")!;
    expect(agent.name).toBe("auditor");
    expect(agent.description).toBe("Security Auditor");
    expect(agent.builtinToolNames).toEqual(["read", "grep", "find"]);
    expect(agent.model).toBe("anthropic/claude-opus-4-6");
    expect(agent.thinking).toBe("high");
    expect(agent.maxTurns).toBe(30);
    expect(agent.persistSession).toBe(true);
    expect(agent.outputTranscript).toBe(false);
    expect(agent.sessionDir).toBe(".seams/pi-sessions/seam-plan-reviewer");
    expect(agent.allowedSubagents).toEqual(["scout", "reviewer"]);
    expect(agent.promptMode).toBe("replace");
    expect(agent.inheritContext).toBe(true);
    expect(agent.runInBackground).toBe(true);
    expect(agent.isolated).toBe(true);
    expect(agent.systemPrompt).toBe("You are a security auditor.");
  });

  it("uses sensible defaults when frontmatter is empty", () => {
    writeAgent("minimal", `---
---

Just a prompt.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("minimal")!;

    expect(agent.name).toBe("minimal");
    expect(agent.description).toBe("minimal"); // defaults to filename
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES); // all tools
    expect(agent.extensions).toBe(true); // inherit all
    expect(agent.skills).toBe(true); // inherit all
    expect(agent.model).toBeUndefined();
    expect(agent.thinking).toBeUndefined();
    expect(agent.maxTurns).toBeUndefined();
    expect(agent.persistSession).toBeUndefined();
    expect(agent.outputTranscript).toBeUndefined();
    expect(agent.sessionDir).toBeUndefined();
    expect(agent.allowedSubagents).toBeUndefined();
    expect(agent.promptMode).toBe("replace");
    expect(agent.inheritContext).toBeUndefined();
    expect(agent.runInBackground).toBeUndefined();
    expect(agent.isolated).toBeUndefined();
    expect(agent.systemPrompt).toBe("Just a prompt.");
  });

  it("uses sensible defaults when no frontmatter at all", () => {
    writeAgent("bare", "Just a system prompt, no frontmatter.");

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("bare")!;

    expect(agent.name).toBe("bare");
    expect(agent.description).toBe("bare");
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    expect(agent.systemPrompt).toBe("Just a system prompt, no frontmatter.");
  });

  it("parses allowed_subagents: off by default, `all` wildcard, csv restriction", () => {
    writeAgent("omitted", `---
---
Off.`);
    writeAgent("unrestricted", `---
allowed_subagents: all
---
Unrestricted.`);
    writeAgent("wildcard", `---
allowed_subagents: "*"
---
Unrestricted.`);
    writeAgent("mixed-case", `---
allowed_subagents: scout, ALL
---
Unrestricted.`);
    writeAgent("none", `---
allowed_subagents: none
---
Off.`);
    writeAgent("blank", `---
allowed_subagents:
---
Off.`);
    writeAgent("restricted", `---
allowed_subagents: scout, reviewer
---
Restricted.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("omitted")!.allowedSubagents).toBeUndefined();
    expect(result.get("unrestricted")!.allowedSubagents).toBe("all");
    expect(result.get("wildcard")!.allowedSubagents).toBe("all");
    expect(result.get("mixed-case")!.allowedSubagents).toBe("all");
    expect(result.get("none")!.allowedSubagents).toBeUndefined();
    expect(result.get("blank")!.allowedSubagents).toBeUndefined();
    expect(result.get("restricted")!.allowedSubagents).toEqual(["scout", "reviewer"]);
  });

  it("accepts booleans like extensions:/skills: do, instead of a type named \"true\"", () => {
    writeAgent("bool-on", `---
allowed_subagents: true
---
On.`);
    writeAgent("bool-off", `---
allowed_subagents: false
---
Off.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("bool-on")!.allowedSubagents).toBe("all");
    expect(result.get("bool-off")!.allowedSubagents).toBeUndefined();
  });

  it("handles tools: none → empty array", () => {
    writeAgent("notool", `---
tools: none
---

No tools.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("notool")!.builtinToolNames).toEqual([]);
  });

  it("handles extensions: false → no extensions", () => {
    writeAgent("noext", `---
extensions: false
skills: false
---

No extensions.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("noext")!;
    expect(agent.extensions).toBe(false);
    expect(agent.skills).toBe(false);
  });

  it("handles extension allowlist", () => {
    writeAgent("partial", `---
extensions: web-search, mcp-server
skills: planning, review
---

Partial access.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("partial")!;
    expect(agent.extensions).toEqual(["web-search", "mcp-server"]);
    expect(agent.skills).toEqual(["planning", "review"]);
  });

  it("passes through unknown tool names (not filtered)", () => {
    writeAgent("custom-tools", `---
tools: read, my_custom_tool, grep
---

Custom tools.`);

    const result = loadCustomAgents(tmpDir);
    // Unknown tool names are passed through — filtering happens at tool creation time
    expect(result.get("custom-tools")!.builtinToolNames).toEqual(["read", "my_custom_tool", "grep"]);
  });

  it("passes through thinking level as-is (no validation)", () => {
    writeAgent("anythink", `---
thinking: turbo
---

Any thinking.`);

    const result = loadCustomAgents(tmpDir);
    // Pi validates at session creation — we just pass through
    expect(result.get("anythink")!.thinking).toBe("turbo");
  });

  it("loads thinking: max (pi 0.80's top level) unchanged (#147)", () => {
    writeAgent("deepthink", `---
thinking: max
---

Think hard.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("deepthink")!.thinking).toBe("max");
  });

  it("accepts max_turns: 0 as unlimited", () => {
    writeAgent("unlimited", `---
max_turns: 0
---

Unlimited turns.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("unlimited")!.maxTurns).toBe(0);
  });

  it("rejects negative max_turns", () => {
    writeAgent("negturns", `---
max_turns: -5
---

Negative turns.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("negturns")!.maxTurns).toBeUndefined();
  });

  it("handles prompt_mode: append", () => {
    writeAgent("appender", `---
prompt_mode: append
---

Extra instructions.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("appender")!.promptMode).toBe("append");
  });

  it("defaults unknown prompt_mode to replace", () => {
    writeAgent("badmode", `---
prompt_mode: merge
---

Unknown mode.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("badmode")!.promptMode).toBe("replace");
  });

  it("loads multiple agents", () => {
    writeAgent("agent1", `---
description: First
---

First agent.`);
    writeAgent("agent2", `---
description: Second
---

Second agent.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(2);
    expect(result.has("agent1")).toBe(true);
    expect(result.has("agent2")).toBe(true);
  });

  it("skips non-.md files", () => {
    const dir = join(tmpDir, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "not an agent");
    writeFileSync(join(dir, "real.md"), `---
description: Real Agent
---

Real.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.has("real")).toBe(true);
  });

  it("allows agents with names matching defaults (overrides them)", () => {
    writeAgent("Explore", `---
description: Custom Explore
---

Custom explore agent.`);
    writeAgent("custom", `---
description: Custom Agent
---

Should be loaded.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.has("Explore")).toBe(true);
    expect(result.get("Explore")!.description).toBe("Custom Explore");
    expect(result.has("custom")).toBe(true);
  });

  it("handles empty body with frontmatter", () => {
    writeAgent("nobody", `---
description: No body
tools: read
---
`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("nobody")!.systemPrompt).toBe("");
  });

  it("supports inherit_extensions as alternative to extensions", () => {
    writeAgent("altkey", `---
inherit_extensions: false
inherit_skills: false
---

Alt keys.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("altkey")!;
    expect(agent.extensions).toBe(false);
    expect(agent.skills).toBe(false);
  });

  it("extensions: none → false", () => {
    writeAgent("extnone", `---
extensions: none
skills: none
---

None.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("extnone")!;
    expect(agent.extensions).toBe(false);
    expect(agent.skills).toBe(false);
  });

  it("extensions: true → true (inherit all)", () => {
    writeAgent("exttrue", `---
extensions: true
skills: true
---

All.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("exttrue")!;
    expect(agent.extensions).toBe(true);
    expect(agent.skills).toBe(true);
  });

  it("handles enabled: false frontmatter", () => {
    writeAgent("disabled", `---
enabled: false
---
`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("disabled")!;
    expect(agent.enabled).toBe(false);
  });

  it("parses display_name frontmatter", () => {
    writeAgent("myagent", `---
description: My Agent
display_name: MyAgent
---

Agent prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("myagent")!.displayName).toBe("MyAgent");
  });

  it("parses disallowed_tools as csv list", () => {
    writeAgent("restricted", `---
description: Restricted Agent
disallowed_tools: bash, write
---

No bash or write.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("restricted")!;
    expect(agent.disallowedTools).toEqual(["bash", "write"]);
  });

  it("disallowed_tools defaults to undefined when omitted", () => {
    writeAgent("unrestricted", `---
description: Unrestricted
---

All tools.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("unrestricted")!.disallowedTools).toBeUndefined();
  });

  it("parses memory scope", () => {
    writeAgent("rememberer", `---
description: Agent with memory
memory: project
---

Remember things.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("rememberer")!.memory).toBe("project");
  });

  it("parses memory: user scope", () => {
    writeAgent("global-mem", `---
memory: user
---

User memory.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("global-mem")!.memory).toBe("user");
  });

  it("memory defaults to undefined when omitted", () => {
    writeAgent("no-mem", `---
description: No memory
---

Stateless.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("no-mem")!.memory).toBeUndefined();
  });

  it("rejects invalid memory scope", () => {
    writeAgent("bad-mem", `---
memory: invalid
---

Bad memory.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("bad-mem")!.memory).toBeUndefined();
  });

  it("parses isolation: worktree", () => {
    writeAgent("isolated-wt", `---
description: Worktree agent
isolation: worktree
---

Isolated.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("isolated-wt")!.isolation).toBe("worktree");
  });

  it("isolation defaults to undefined when omitted", () => {
    writeAgent("no-isolation", `---
description: Normal
---

Normal.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("no-isolation")!.isolation).toBeUndefined();
  });

  it("rejects invalid isolation mode", () => {
    writeAgent("bad-isolation", `---
isolation: docker
---

Bad isolation.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("bad-isolation")!.isolation).toBeUndefined();
  });

  it("honors PI_CODING_AGENT_DIR for global custom agent discovery", () => {
    const altAgentDir = mkdtempSync(join(tmpdir(), "pi-alt-agent-"));
    const originalEnv = process.env['PI_CODING_AGENT_DIR'];
    process.env['PI_CODING_AGENT_DIR'] = altAgentDir;
    try {
      const globalAgentsDir = join(altAgentDir, "agents");
      mkdirSync(globalAgentsDir, { recursive: true });
      writeFileSync(
        join(globalAgentsDir, "via-env.md"),
        "---\ndescription: Discovered via env var\n---\n\nTest body.",
      );

      const result = loadCustomAgents(tmpDir);

      // Agent is found at $PI_CODING_AGENT_DIR/agents, not at $HOME/.pi/agent/agents
      expect(result.has("via-env")).toBe(true);
      expect(result.get("via-env")!.description).toBe("Discovered via env var");
    } finally {
      if (originalEnv == null) delete process.env['PI_CODING_AGENT_DIR'];
      else process.env['PI_CODING_AGENT_DIR'] = originalEnv;
      rmSync(altAgentDir, { recursive: true, force: true });
    }
  });

  describe("ext: selectors in tools: field", () => {
    let agentDir: string;

    beforeEach(() => {
      agentDir = join(tmpDir, ".pi", "agents");
      mkdirSync(agentDir, { recursive: true });
    });

  it("parses ext: entries into extSelectors and excludes them from builtinToolNames", () => {
    writeFileSync(join(agentDir, "ext-agent.md"),
      "---\ndescription: Uses ext selectors\ntools: read, ext:pi-subagents, ext:foo/MyTool\n---\n\nBody.");
    const result = loadCustomAgents(tmpDir);
    const config = result.get("ext-agent");
    expect(config).toBeDefined();
    expect(config!.builtinToolNames).toEqual(["read"]);
    expect(config!.extSelectors).toEqual(["ext:pi-subagents", "ext:foo/MyTool"]);
  });

  it("tools: * expands to all built-ins and extSelectors are still separated", () => {
    writeFileSync(join(agentDir, "wildcard-agent.md"),
      "---\ndescription: Wildcard\ntools: all, ext:pi-subagents\n---\n\nBody.");
    const result = loadCustomAgents(tmpDir);
    const config = result.get("wildcard-agent");
    expect(config).toBeDefined();
    expect(config!.builtinToolNames).toEqual(expect.arrayContaining(["read", "bash"]));
    expect(config!.extSelectors).toEqual(["ext:pi-subagents"]);
  });

  it("extSelectors is undefined when no ext: entries present", () => {
    writeFileSync(join(agentDir, "no-ext-agent.md"),
      "---\ndescription: No ext\ntools: read\n---\n\nBody.");
    const result = loadCustomAgents(tmpDir);
    const config = result.get("no-ext-agent");
    expect(config!.extSelectors).toBeUndefined();
  });
});
});

describe("loadCustomAgents — error recovery", () => {
  let tmpDir2: string;
  let savedHome: string | undefined;
  let savedAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir2 = mkdtempSync(join(tmpdir(), "pi-test-agents-error-"));
    savedHome = process.env['HOME'];
    savedAgentDir = process.env['PI_CODING_AGENT_DIR'];
    process.env['HOME'] = tmpDir2;
    process.env['PI_CODING_AGENT_DIR'] = join(tmpDir2, '.pi', 'agent');
  });

  afterEach(() => {
    if (savedHome !== undefined) process.env['HOME'] = savedHome;
    else delete process.env['HOME'];
    if (savedAgentDir !== undefined) process.env['PI_CODING_AGENT_DIR'] = savedAgentDir;
    else delete process.env['PI_CODING_AGENT_DIR'];
    rmSync(tmpDir2, { recursive: true, force: true });
  });

  it("returns empty map when the agents directory does not exist (readdirSync throws)", () => {
    // No .pi/agents directory created — readdirSync will throw ENOENT
    const result = loadCustomAgents(tmpDir2);
    expect(result.size).toBe(0);
  });

  it("skips individual .md files that are unreadable (readFileSync throws)", () => {
    const agentDir2 = join(tmpDir2, ".pi", "agents");
    mkdirSync(agentDir2, { recursive: true });

    // Create a readable agent file
    writeFileSync(join(agentDir2, "good-agent.md"), "---\ndescription: Good\n---\nBody.");

    // Create an unreadable agent file
    const badFile = join(agentDir2, "bad-agent.md");
    writeFileSync(badFile, "---\ndescription: Bad\n---\nBody.");
    chmodSync(badFile, 0o000);

    try {
      const result = loadCustomAgents(tmpDir2);
      // good-agent was loaded; bad-agent was skipped
      expect(result.has("good-agent")).toBe(true);
      expect(result.has("bad-agent")).toBe(false);
    } finally {
      chmodSync(badFile, 0o644);
    }
  });

  it("returns empty map when readdirSync throws on an existing agents dir (line 38)", () => {
    // Create agents directory but make it unreadable → readdirSync throws EACCES
    const agentDir3 = join(tmpDir2, ".pi", "agents");
    mkdirSync(agentDir3, { recursive: true });
    chmodSync(agentDir3, 0o000);

    try {
      const result = loadCustomAgents(tmpDir2);
      // The readdirSync failure is swallowed — returns an empty/partial map
      expect(result.size).toBe(0);
    } finally {
      chmodSync(agentDir3, 0o755);
    }
  });
});
