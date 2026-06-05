/**
 * Runtime tests — load a workflow file and invoke its default export.
 *
 * The framework must:
 *  - publish a `started` event before the workflow runs;
 *  - forward every `host.publish(...)` event verbatim;
 *  - publish a `completed` event when the workflow returns normally;
 *  - publish an `error` event (NOT throw) when the workflow throws;
 *  - publish an `error` event when the workflow file lacks a default fn;
 *  - reject a second invocation while one is active (concurrency guard);
 *  - propagate `signal.abort()` into `host.signal`.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	runWorkflow,
	resetActiveRunForTests,
	type RunWorkflowDeps,
} from "../src/runtime.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIX = join(__dirname, "fixtures");

interface SentMessage {
	readonly customType: string;
	readonly content: string;
	readonly details?: Record<string, unknown>;
}

// Module-level so makeDeps (also module-level) can close over it.
// Reset per test by the suite's beforeEach; rmSync'd by afterEach.
let tmpHome: string;

function makeDeps(overrides: Partial<RunWorkflowDeps> = {}): {
	deps: RunWorkflowDeps;
	sent: SentMessage[];
} {
	const sent: SentMessage[] = [];
	const sendMessage = vi.fn((m: unknown) => {
		const msg = m as SentMessage;
		sent.push(msg);
	});
	const deps: RunWorkflowDeps = {
		sendMessage,
		notify: vi.fn(),
		setStatus: vi.fn(),
		clearStatus: vi.fn(),
		cwd: "/cwd",
		signal: undefined,
		homedir: tmpHome,
		...overrides,
	};
	return { deps, sent };
}

describe("runWorkflow", () => {
	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "pi-sandboxed-workflows-runtime-"));
		resetActiveRunForTests();
	});

	afterEach(() => {
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("forwards every published event and brackets them with started/completed", async () => {
		const { deps, sent } = makeDeps();
		await runWorkflow({
			deps,
			script: { name: "ok", path: join(FIX, "ok.ts") },
			args: "go",
		});
		const kinds = sent
			.filter((m) => m.customType === "pi-sandboxed-workflows:event")
			.map((m) => m.details?.["kind"]);
		expect(kinds).toEqual(["started", "step", "step", "step", "completed"]);
	});

	it("publishes an error event when the workflow throws and does NOT re-throw", async () => {
		const { deps, sent } = makeDeps();
		await expect(
			runWorkflow({
				deps,
				script: { name: "throws", path: join(FIX, "throws.ts") },
				args: "",
			}),
		).resolves.toBe("error");
		const errEvents = sent.filter((m) => m.details?.["kind"] === "error");
		expect(errEvents).toHaveLength(1);
		expect(String(errEvents[0]?.content)).toContain("boom");
		// Framework error events MUST also surface as a toast for immediate UX,
		// while the sendMessage above is what the LLM sees on the next turn.
		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringContaining("boom"),
			"error",
		);
	});

	it("publishes an error event when the file has no default export", async () => {
		const { deps, sent } = makeDeps();
		await runWorkflow({
			deps,
			script: { name: "missing", path: join(FIX, "missing-default.ts") },
			args: "",
		});
		const errEvents = sent.filter((m) => m.details?.["kind"] === "error");
		expect(errEvents).toHaveLength(1);
		expect(String(errEvents[0]?.content)).toMatch(/default export/i);
		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringMatching(/default export/i),
			"error",
		);
	});

	it("publishes an error event when the default export is not a function", async () => {
		const { deps, sent } = makeDeps();
		await runWorkflow({
			deps,
			script: { name: "naf", path: join(FIX, "not-a-function.ts") },
			args: "",
		});
		const errEvents = sent.filter((m) => m.details?.["kind"] === "error");
		expect(errEvents).toHaveLength(1);
		expect(String(errEvents[0]?.content)).toMatch(/not a function|default export/i);
		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringMatching(/not a function|default export/i),
			"error",
		);
	});

	it("rejects concurrent invocations and ALSO publishes a chat message so the LLM sees it", async () => {
		const { deps: deps1 } = makeDeps();
		const { deps: deps2, sent: sent2 } = makeDeps();
		const ac = new AbortController();
		const first = runWorkflow({
			deps: { ...deps1, signal: ac.signal },
			script: { name: "long", path: join(FIX, "long-running.ts") },
			args: "",
		});
		// Yield so `first` enters its body and registers as active.
		await Promise.resolve();
		await runWorkflow({
			deps: deps2,
			script: { name: "ok", path: join(FIX, "ok.ts") },
			args: "",
		});
		// Toast for the human.
		expect(deps2.notify).toHaveBeenCalledOnce();
		// Custom message for the LLM. Should be a single `concurrent-rejected`
		// event — no `started`/`completed` for the rejected attempt.
		const kinds = sent2
			.filter((m) => m.customType === "pi-sandboxed-workflows:event")
			.map((m) => m.details?.["kind"]);
		expect(kinds).toEqual(["concurrent-rejected"]);
		// Cancel the first run so the test exits cleanly.
		ac.abort();
		await first;
	});

	it("propagates ctx.signal into host.signal so user cancellation aborts the workflow", async () => {
		const ac = new AbortController();
		const { deps } = makeDeps({ signal: ac.signal });
		const promise = runWorkflow({
			deps,
			script: { name: "long", path: join(FIX, "long-running.ts") },
			args: "",
		});
		// Give the workflow a tick to attach its abort listener.
		await new Promise((r) => setTimeout(r, 10));
		ac.abort();
		await promise;
	});
});
