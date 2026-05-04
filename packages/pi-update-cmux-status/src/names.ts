/**
 * LLM-driven naming of cmux workspaces, based on a short summary of the
 * current pi session.
 *
 * This module is pure orchestration — the single live-IO call to
 * `completeSimple` lives in `namesCompletion.ts` (excluded from
 * coverage) and is swappable via the `completion` option on
 * `generateNames` for tests.
 *
 * Tab naming was removed in #0003 (user request: "remove tab renaming
 * from the extension"). The public shape is kept as a record so
 * callers don't need to care about how many fields live in it; for now
 * the single field is `workspace`.
 */

import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { resolveSummaryModelOverride } from "./config.js";
import { runSummaryCompletion, type SummaryCompletionAuth } from "./namesCompletion.js";

/** Result of a successful naming call. */
export interface Names {
	workspace: string;
}

/** Maximum character length of the workspace title we pass to cmux. */
export const MAX_WORKSPACE_CHARS = 60;

/** System prompt — exported so tests can snapshot it. */
export const SUMMARY_SYSTEM_PROMPT =
	"You name cmux workspaces based on a short summary of a coding-agent session.\n" +
	"The input is one or more recent user messages from the session, joined with blank lines (newest last when truncated).\n" +
	'Output a single JSON object exactly of the form {"workspace":"..."} and nothing else.\n' +
	"Rules:\n" +
	`- "workspace": up to ${MAX_WORKSPACE_CHARS} characters, Title Case, the broad theme of the session (e.g. "Pi Extensions", "Debug OAuth Token Refresh Flow").\n` +
	"- Be concise but concrete — aim shorter than the cap when the session has an obvious short label, longer when extra context helps disambiguate.\n" +
	"- Favour the most recent user messages when they disagree with earlier ones — the session has evolved.\n" +
	"- No quotes, no emojis, no trailing punctuation.\n" +
	'- No leading verbs like "Help with" or "Fix" — just the thing itself.\n' +
	'- If the input is a single word like "hi", still produce something reasonable (e.g. workspace: "Chat").';

/** Cap prompt length we ship to the summariser — a gist is enough. */
export const MAX_PROMPT_CHARS = 2000;

/** Token budget for the summary completion. */
export const SUMMARY_MAX_TOKENS = 120;

/**
 * Clip a candidate workspace string to `max` characters. Prefers
 * word-boundary truncation when one is available in the final ~40% of
 * the budget (i.e. we never drop more than ~60% of the allowed content
 * just to land on a space).
 */
export function clipToLimit(s: string, max: number): string {
	const trimmed = s.trim();
	if (trimmed.length <= max) return trimmed;
	const cut = trimmed.slice(0, max);
	const lastSpace = cut.lastIndexOf(" ");
	if (lastSpace > Math.floor(max * 0.6)) {
		return cut.slice(0, lastSpace).trimEnd();
	}
	return cut.trimEnd();
}

/**
 * Extract a `{workspace}` pair from arbitrary model output. Finds the
 * first `{...}` JSON object in the text and validates its shape; tolerates
 * surrounding prose or stray trailing text. The workspace string is
 * clipped to {@link MAX_WORKSPACE_CHARS}.
 *
 * Returns `undefined` when no usable object could be parsed.
 */
export function parseNames(raw: string | undefined | null): Names | undefined {
	if (!raw) return undefined;
	const match = raw.match(/\{[\s\S]*\}/);
	if (!match) return undefined;
	try {
		const obj = JSON.parse(match[0]) as Record<string, unknown>;
		const rawWorkspace =
			typeof obj["workspace"] === "string" ? (obj["workspace"] as string) : "";
		const workspace = clipToLimit(rawWorkspace, MAX_WORKSPACE_CHARS);
		if (!workspace) return undefined;
		return { workspace };
	} catch {
		return undefined;
	}
}

/**
 * Pick the summariser model: explicit override from `$PI_CMUX_SUMMARY_MODEL`
 * if it parses, otherwise the session's own model.
 */
export function resolveSummaryModel(
	ctx: Pick<ExtensionContext, "model">,
	env: NodeJS.ProcessEnv = process.env,
): Model<Api> | undefined {
	const override = resolveSummaryModelOverride(env);
	if (override) {
		try {
			const m = getModel(override.provider as never, override.modelId as never);
			if (m) return m as Model<Api>;
		} catch {
			// fall through to session model
		}
	}
	return ctx.model as Model<Api> | undefined;
}

/** Interface used by `generateNames` — narrow subset of `ExtensionContext`. */
export interface NamesContext {
	model?: ExtensionContext["model"];
	modelRegistry: ExtensionContext["modelRegistry"];
}

/**
 * Signature of the live-IO hook. Default: `runSummaryCompletion` in
 * `namesCompletion.ts`. Tests can inject a stub so the orchestration in
 * `generateNames` can be exercised without a real model.
 */
export type SummaryCompletion = (
	model: Model<Api>,
	prompt: string,
	auth: SummaryCompletionAuth,
	opts: { systemPrompt: string; maxTokens: number },
) => Promise<string | undefined>;

/**
 * Call the summariser model and return the workspace name, or
 * `undefined` on any failure (no model, auth error, bad response → all
 * collapse to a silent fall-back in the extension).
 */
export async function generateNames(
	ctx: NamesContext,
	firstPrompt: string,
	env: NodeJS.ProcessEnv = process.env,
	completion: SummaryCompletion = runSummaryCompletion,
): Promise<Names | undefined> {
	const model = resolveSummaryModel(ctx as Pick<ExtensionContext, "model">, env);
	if (!model) return undefined;

	let auth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
	try {
		auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	} catch {
		return undefined;
	}
	if (!auth.ok) return undefined;

	// Keep the *tail* — when the caller passed a joined transcript of
	// recent user messages, the most recent turns sit at the end and should
	// survive truncation.
	const trimmed =
		firstPrompt.length > MAX_PROMPT_CHARS
			? firstPrompt.slice(firstPrompt.length - MAX_PROMPT_CHARS)
			: firstPrompt;

	const text = await completion(
		model,
		trimmed,
		{ apiKey: auth.apiKey, headers: auth.headers },
		{ systemPrompt: SUMMARY_SYSTEM_PROMPT, maxTokens: SUMMARY_MAX_TOKENS },
	);
	return parseNames(text);
}
