/**
 * Extension entry-point tests.
 *
 * The factory must:
 *  - load `~/.pi/agent/pi-sandboxed-workflows.json` (creating it on first
 *    run) and resolve the configured directory list;
 *  - register exactly one `/workflow:<name>` command per discovered script;
 *  - register `/sandbox-workflow` once for the browser TUI;
 *  - register a message renderer for the workflow event customType;
 *  - emit a notify warning for each rejected filename.
 *
 * Tests use a stub ExtensionAPI rather than importing pi-coding-agent.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import piSandboxedWorkflows from "../src/index.js";
import { EVENT_CUSTOM_TYPE } from "../src/host.js";
import { Key } from "@earendil-works/pi-tui";

interface RegisteredCommand {
	readonly description: string;
	readonly handler: (args: string, ctx: unknown) => Promise<void> | void;
}

interface StubPi {
	readonly registerCommand: ReturnType<typeof vi.fn>;
	readonly registerMessageRenderer: ReturnType<typeof vi.fn>;
	readonly registerShortcut: ReturnType<typeof vi.fn>;
	readonly on: ReturnType<typeof vi.fn>;
	readonly sendMessage: ReturnType<typeof vi.fn>;
	readonly commands: Map<string, RegisteredCommand>;
	readonly renderers: Map<string, unknown>;
}

function makePi(): StubPi {
	const commands = new Map<string, RegisteredCommand>();
	const renderers = new Map<string, unknown>();
	return {
		registerCommand: vi.fn((name: string, opts: RegisteredCommand) => {
			commands.set(name, opts);
		}),
		registerMessageRenderer: vi.fn((customType: string, renderer: unknown) => {
			renderers.set(customType, renderer);
		}),
		registerShortcut: vi.fn(),
		on: vi.fn(),
		sendMessage: vi.fn(),
		commands,
		renderers,
	};
}

describe("piSandboxedWorkflows factory", () => {
	let home: string;
	let workflowsDir: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "pi-sw-home-"));
		// The default config will point here. Pre-create the dir so writes
		// inside it are straightforward.
		workflowsDir = join(home, ".pi", "agent", "sandboxed-workflows");
		mkdirSync(workflowsDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	function writeWorkflow(
		name: string,
		contents = "export default async () => {};\n",
		dir = workflowsDir,
	): void {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, name), contents);
	}

	it("registers /sandbox-workflow command exactly once", () => {
		const pi = makePi();
		piSandboxedWorkflows(pi as never, { homedir: home });
		expect(pi.commands.has("sandbox-workflow")).toBe(true);
		expect(pi.commands.get("sandbox-workflow")?.description).toMatch(/browse/i);
	});

	it("registers /workflow:<name> for every discovered workflow", () => {
		writeWorkflow("implement.workflow.ts");
		writeWorkflow("triage.workflow.ts");
		const pi = makePi();
		piSandboxedWorkflows(pi as never, { homedir: home });
		const workflowKeys = [...pi.commands.keys()]
			.filter((k) => k.startsWith("workflow:") && k !== "workflow:stop-all")
			.sort();
		expect(workflowKeys).toEqual(["workflow:implement", "workflow:triage"]);
	});

	it("registers a message renderer for the workflow event customType", () => {
		const pi = makePi();
		piSandboxedWorkflows(pi as never, { homedir: home });
		expect(pi.renderers.has(EVENT_CUSTOM_TYPE)).toBe(true);
	});

	it("creates the config file on first run pointing at the default directory", () => {
		const pi = makePi();
		piSandboxedWorkflows(pi as never, { homedir: home });
		const cfgPath = join(home, ".pi", "agent", "pi-sandboxed-workflows.json");
		// Read with fs to verify the on-disk content.
		// (Using require/dynamic import would create a noise dep; sync read is fine.)
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { readFileSync } = require("node:fs") as { readFileSync: (p: string) => Buffer };
		const body = readFileSync(cfgPath).toString();
		expect(body).toContain("~/.pi/agent/sandboxed-workflows");
	});

	it("scans every directory in the config and merges results", () => {
		// Set up a second directory and point the config at both.
		const second = mkdtempSync(join(tmpdir(), "pi-sw-second-"));
		try {
			writeWorkflow("primary.workflow.ts", undefined, workflowsDir);
			writeWorkflow("secondary.workflow.ts", undefined, second);
			// Pre-write the config so the factory reads our 2-entry list
			// (instead of bootstrapping just the default dir).
			const cfgDir = join(home, ".pi", "agent");
			mkdirSync(cfgDir, { recursive: true });
			writeFileSync(
				join(cfgDir, "pi-sandboxed-workflows.json"),
				JSON.stringify({
					directories: [workflowsDir, second],
				}),
			);
			const pi = makePi();
			piSandboxedWorkflows(pi as never, { homedir: home });
			const workflowKeys = [...pi.commands.keys()]
				.filter((k) => k.startsWith("workflow:") && k !== "workflow:stop-all")
				.sort();
			expect(workflowKeys).toEqual(["workflow:primary", "workflow:secondary"]);
		} finally {
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("notifies once per workflow file with an unusable name", () => {
		writeWorkflow("Bad.workflow.ts");
		writeWorkflow("ok.workflow.ts");
		const pi = makePi();
		const notify = vi.fn();
		piSandboxedWorkflows(pi as never, {
			homedir: home,
			notify: (m, l) => {
				notify(m, l);
			},
		});
		const workflowKeys = [...pi.commands.keys()].filter((k) => k.startsWith("workflow:") && k !== "workflow:stop-all");
		expect(workflowKeys).toEqual(["workflow:ok"]);
		expect(notify).toHaveBeenCalledTimes(1);
		const [msg, level] = notify.mock.calls[0] as [string, string];
		expect(msg).toContain("Bad.workflow.ts");
		expect(level).toBe("warning");
	});

	it("notifies on collision between directories (same workflow name in two dirs)", () => {
		const second = mkdtempSync(join(tmpdir(), "pi-sw-second-"));
		try {
			writeWorkflow("hello.workflow.ts", undefined, workflowsDir);
			writeWorkflow("hello.workflow.ts", undefined, second);
			const cfgDir = join(home, ".pi", "agent");
			mkdirSync(cfgDir, { recursive: true });
			writeFileSync(
				join(cfgDir, "pi-sandboxed-workflows.json"),
				JSON.stringify({ directories: [workflowsDir, second] }),
			);
			const pi = makePi();
			const notify = vi.fn();
			piSandboxedWorkflows(pi as never, {
				homedir: home,
				notify: (m, l) => {
					notify(m, l);
				},
			});
			expect(notify).toHaveBeenCalledTimes(1);
			const [msg] = notify.mock.calls[0] as [string, string];
			expect(msg).toMatch(/duplicate/i);
		} finally {
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("surfaces a malformed config error via notify+sendMessage WITHOUT throwing", () => {
		const cfgDir = join(home, ".pi", "agent");
		mkdirSync(cfgDir, { recursive: true });
		writeFileSync(join(cfgDir, "pi-sandboxed-workflows.json"), "{not json");
		const pi = makePi();
		const notify = vi.fn();
		expect(() =>
			piSandboxedWorkflows(pi as never, {
				homedir: home,
				notify: (m, l) => {
					notify(m, l);
				},
			}),
		).not.toThrow();
		expect(notify).toHaveBeenCalled();
		const [msg, level] = notify.mock.calls[0] as [string, string];
		expect(msg).toMatch(/pi-sandboxed-workflows\.json/);
		expect(level).toBe("error");
	});

	it("registers Ctrl+Alt+C shortcut to cancel running workflows", () => {
		writeWorkflow("do-stuff.workflow.ts");
		const pi = makePi();
		piSandboxedWorkflows(pi as never, { homedir: home });
		const calls = pi.registerShortcut.mock.calls as Array<[unknown, unknown]>;
		const keys = calls.map(([k]) => k);
		expect(keys).toContainEqual(Key.ctrlAlt("c"));
	});
});
