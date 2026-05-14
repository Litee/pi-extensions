/**
 * Completion-checker orchestrator for pi-goal.
 *
 * After every primary-agent turn, we ask a small/cheap model (Haiku-class by
 * default) whether the goal is satisfied. The checker is the SOLE arbiter of
 * completion — the primary agent never decides for itself.
 *
 * Architecture mirrors `pi-session-recap`'s `recapOrchestrator`:
 *  - Pure dependency injection for `completeSimple` + `getModel`, so the
 *    orchestrator unit-tests with no pi-ai I/O.
 *  - One in-flight check at a time; a new check cancels the previous one.
 *  - SigV4 friendly: we tolerate `auth.apiKey === undefined` (Bedrock signs
 *    requests via headers) — pi-session-recap's pattern of bailing on
 *    undefined apiKey would lock us out of Amazon Bedrock entirely.
 */

import type { completeSimple as completeSimpleFn, getModel as getModelFn } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildCheckerUserPrompt, CHECKER_SYSTEM_PROMPT } from "./prompt.js";

type Model = Parameters<typeof completeSimpleFn>[0];

export type CheckerVerdict = "complete" | "incomplete";

export interface CheckerResult {
	verdict: CheckerVerdict;
	confidence: "low" | "medium" | "high";
	reason: string;
	/** Raw text from the model — kept around for diagnostics / status display. */
	rawText: string;
}

export interface CheckerConfig {
	/** Provider/id spec, e.g. "amazon-bedrock/global.anthropic.claude-haiku-4-5". Falls back to ctx.model when unset. */
	modelOverride: () => string | undefined;
	/** Max characters of transcript to send to the checker. Default 8 KB is plenty for "did the agent answer the question?" judgements. */
	maxTranscriptChars?: () => number;
}

export interface CheckerDeps {
	completeSimple: typeof completeSimpleFn;
	getModel: typeof getModelFn;
	ctx: ExtensionContext;
	config: CheckerConfig;
	/** Called with non-abort errors so callers can decide whether to surface them. */
	onError?: (err: unknown) => void;
}

/** Default ceiling on transcript characters passed to the checker. */
export const DEFAULT_MAX_TRANSCRIPT_CHARS = 8_000;

/**
 * Parse a model spec of the form `"provider/id"` into its parts. Same shape
 * used by pi-session-recap; duplicated here to avoid a cross-package import.
 */
export function splitModelSpec(spec: string): { provider: string; id: string } | undefined {
	const slash = spec.indexOf("/");
	if (slash < 1 || slash >= spec.length - 1) return undefined;
	return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

/**
 * Tolerant JSON-extraction: the checker is told to emit strict JSON, but
 * Haiku-class models occasionally wrap output in ```json fences or prepend
 * filler. We accept any well-formed JSON object found in the response.
 */
export function parseCheckerJson(raw: string): CheckerResult | undefined {
	const trimmed = raw.trim();
	const candidates: string[] = [trimmed];
	const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
	if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());
	const braceStart = trimmed.indexOf("{");
	const braceEnd = trimmed.lastIndexOf("}");
	if (braceStart >= 0 && braceEnd > braceStart) {
		candidates.push(trimmed.slice(braceStart, braceEnd + 1));
	}

	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (parsed === null || typeof parsed !== "object") continue;
			const obj = parsed as Record<string, unknown>;
			const verdict = obj["verdict"];
			if (verdict !== "complete" && verdict !== "incomplete") continue;
			const confidence =
				obj["confidence"] === "low" ||
				obj["confidence"] === "medium" ||
				obj["confidence"] === "high"
					? obj["confidence"]
					: "medium";
			const reason = typeof obj["reason"] === "string" ? obj["reason"] : "";
			return {
				verdict,
				confidence,
				reason,
				rawText: raw,
			};
		} catch {
			// try next candidate
		}
	}
	return undefined;
}

/**
 * Truncate `transcript` to at most `max` characters, keeping the END (most
 * recent material). The checker's evidence is in the latest agent turn, so
 * dropping earlier text rarely changes the verdict.
 */
export function truncateTranscriptTail(transcript: string, max: number): string {
	if (transcript.length <= max) return transcript;
	return `[…earlier transcript truncated…]\n${transcript.slice(transcript.length - max)}`;
}

export interface RunCheckArgs {
	objective: string;
	/** Already-rendered transcript text (caller decides how to render it). */
	transcript: string;
	signal: AbortSignal;
}

export interface CompletionChecker {
	/**
	 * Run one completion check. Resolves to a verdict, or `undefined` if the
	 * checker could not run (no model, no auth, parse failure, abort). The
	 * caller treats `undefined` as "keep going" — failing-open prevents a
	 * checker outage from ending goal mode prematurely.
	 */
	run(args: RunCheckArgs): Promise<CheckerResult | undefined>;
}

/**
 * Build a CompletionChecker. Pure factory — no side effects until `run()`.
 */
export function createCompletionChecker(deps: CheckerDeps): CompletionChecker {
	const maxChars = () => deps.config.maxTranscriptChars?.() ?? DEFAULT_MAX_TRANSCRIPT_CHARS;

	return {
		async run({ objective, transcript, signal }: RunCheckArgs): Promise<CheckerResult | undefined> {
			// 1. Resolve checker model.
			let model: Model | undefined;
			const overrideSpec = deps.config.modelOverride();
			if (overrideSpec) {
				const parsed = splitModelSpec(overrideSpec);
				if (parsed) {
					const found = (
						deps.getModel as (provider: string, id: string) => Model | undefined
					)(parsed.provider, parsed.id);
					if (found) model = found;
				}
			}
			if (!model) model = deps.ctx.model;
			if (!model) return undefined;

			// 2. Resolve auth. Tolerate `apiKey === undefined` for SigV4-style
			//    providers (Bedrock); the underlying streamSimple handler signs
			//    the request itself in that case.
			const auth = await deps.ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth?.ok) return undefined;

			// 3. Render the user prompt with truncated transcript.
			const truncated = truncateTranscriptTail(transcript, maxChars());
			const userPrompt = buildCheckerUserPrompt(objective, truncated);

			// 4. Fire the model call.
			let response;
			try {
				// Build options under exactOptionalPropertyTypes: only attach
				// `apiKey` / `headers` when actually present. SigV4 providers
				// (Bedrock) do not return an apiKey; their custom streamSimple
				// signs the request via headers.
				const options: Parameters<typeof deps.completeSimple>[2] & Record<string, unknown> = {
					signal,
				};
				if (auth.apiKey !== undefined) options["apiKey"] = auth.apiKey;
				if (auth.headers) options["headers"] = auth.headers;
				if (model.reasoning) options["reasoning"] = "minimal";
				response = await deps.completeSimple(
					model,
					{
						systemPrompt: CHECKER_SYSTEM_PROMPT,
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: userPrompt }],
								timestamp: Date.now(),
							},
						],
					},
					options,
				);
			} catch (err) {
				if (signal.aborted) return undefined;
				deps.onError?.(err);
				return undefined;
			}

			if (signal.aborted) return undefined;

			// 5. Parse.
			const text = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();

			return parseCheckerJson(text);
		},
	};
}
