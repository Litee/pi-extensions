/**
 * FakeSandboxProvider — in-process fake for unit tests.
 *
 * Implements SandboxProvider directly (no @ai-hero/sandcastle dependency).
 * `exec()` returns canned responses instead of spawning real processes.
 *
 * Matching strategy:
 *   1. Label-first: look up the current label in the `responses` map.
 *   2. FIFO fallback: if no label match, dequeue from the `fifo` queue.
 *   3. If nothing found and `strict: true` (default), throw an error.
 *
 * The framework sets the current label via `setCurrentLabel(label)` right
 * before calling host.runAgent so the fake can correlate calls to expected
 * responses.
 *
 * For `kind: "object"` responses the value is wrapped in the XML tag that
 * `agent.ts` scans for (`PI_SW_RESULT_TAG` by default).
 *
 * API change vs the sandcastle-backed version:
 *   - Removed `create()` / handle split. Call `provider.exec({command, cwd})`
 *     directly (same as all providers now).
 *   - `FakeCall.command` is `string | readonly string[]` to match ExecOpts.
 */
import type { SandboxProvider, ExecOpts, ExecResult } from "../engine/sandboxProvider.js";
import { PI_SW_RESULT_TAG } from "../structuredOutput.js";

// ── Public types ─────────────────────────────────────────────────────────────

export type FakeResponse =
	| { readonly kind: "text"; readonly stdout: string }
	| { readonly kind: "object"; readonly value: unknown }
	| { readonly kind: "throw"; readonly error: Error };

export interface FakeSandboxOptions {
	/** Pre-registered label → response map (label-first lookup). */
	readonly responses?: Record<string, FakeResponse>;
	/** FIFO queue consumed when no label match is found. */
	readonly fifo?: readonly FakeResponse[];
	/**
	 * Throw when no response is found for a label/FIFO miss.
	 * Default: `true`.
	 */
	readonly strict?: boolean;
	/**
	 * XML tag used to wrap `kind:"object"` responses.
	 * Default: `PI_SW_RESULT_TAG`.
	 */
	readonly tag?: string;
}

/** A recorded exec() invocation. */
export interface FakeCall {
	readonly label: string;
	/** The raw command passed to exec(). */
	readonly command: string | readonly string[];
	readonly cwd: string;
	readonly ts: number;
}

/** A SandboxProvider extended with fake-control methods. */
export interface FakeSandboxProvider extends SandboxProvider {
	/**
	 * Side channel: the framework calls this right before invoking the engine
	 * so the fake can correlate the upcoming exec with the label.
	 */
	setCurrentLabel(label: string): void;
	/** Register or replace a label-keyed response. */
	setResponse(label: string, response: FakeResponse): void;
	/** Push a response onto the FIFO fallback queue. */
	enqueueResponse(response: FakeResponse): void;
	/** All exec() calls observed, in order. */
	readonly calls: ReadonlyArray<FakeCall>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a `FakeSandboxProvider` with optional pre-registered responses.
 */
export function fake(options?: FakeSandboxOptions): FakeSandboxProvider {
	const strict = options?.strict ?? true;
	const tag = options?.tag ?? PI_SW_RESULT_TAG;

	const responseMap = new Map<string, FakeResponse>(
		Object.entries(options?.responses ?? {}),
	);
	const fifoQueue: FakeResponse[] = [...(options?.fifo ?? [])];
	const callLog: FakeCall[] = [];
	let currentLabel = "";

	function makeExecResult(response: FakeResponse): ExecResult {
		if (response.kind === "throw") {
			throw response.error;
		}
		if (response.kind === "object") {
			const wrapped =
				`<${tag}>\n` +
				JSON.stringify(response.value, null, 2) +
				`\n</${tag}>`;
			return { stdout: wrapped, stderr: "", exitCode: 0 };
		}
		// kind === "text"
		return { stdout: response.stdout, stderr: "", exitCode: 0 };
	}

	function resolveResponse(): FakeResponse | undefined {
		// Label-first
		if (currentLabel !== "" && responseMap.has(currentLabel)) {
			return responseMap.get(currentLabel);
		}
		// FIFO fallback
		if (fifoQueue.length > 0) {
			return fifoQueue.shift();
		}
		return undefined;
	}

	const provider: FakeSandboxProvider = {
		name: "fake",

		setCurrentLabel(label: string): void {
			currentLabel = label;
		},

		setResponse(label: string, response: FakeResponse): void {
			responseMap.set(label, response);
		},

		enqueueResponse(response: FakeResponse): void {
			fifoQueue.push(response);
		},

		get calls(): ReadonlyArray<FakeCall> {
			return callLog;
		},

		exec(opts: ExecOpts): Promise<ExecResult> {
			const cwd = opts.cwd ?? process.cwd();
			callLog.push({
				label: currentLabel,
				command: opts.command,
				cwd,
				ts: Date.now(),
			});

			const response = resolveResponse();
			if (response === undefined) {
				if (strict) {
					return Promise.reject(
						new Error(
							`FakeSandboxProvider: no response registered for label "${currentLabel}" and FIFO queue is empty`,
						),
					);
				}
				// Non-strict: return an empty success response.
				return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
			}

			try {
				const result = makeExecResult(response);
				// Feed lines through onLine if provided (satisfies the streaming
				// contract — idle-timeout tracking, line events in runClaudeCode).
				if (opts.onLine !== undefined && result.exitCode === 0) {
					for (const line of result.stdout.split("\n")) {
						opts.onLine(line);
					}
				}
				return Promise.resolve(result);
			} catch (err) {
				return Promise.reject(
					err instanceof Error ? err : new Error(String(err)),
				);
			}
		},
	};

	return provider;
}
