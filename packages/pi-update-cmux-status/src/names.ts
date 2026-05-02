/**
 * LLM-driven naming of cmux tabs + workspaces, based on the first user
 * prompt in a pi session.
 *
 * This module is pure orchestration — the single live-IO call to
 * `completeSimple` lives in `namesCompletion.ts` (which is excluded from
 * coverage) and is swappable via the `completion` option on
 * `generateNames` for tests.
 */

import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { resolveSummaryModelOverride } from "./config.js";
import { runSummaryCompletion, type SummaryCompletionAuth } from "./namesCompletion.js";

/** Result of a successful naming call. */
export interface Names {
	tab: string;
	workspace: string;
}

/** System prompt — exported so tests can snapshot it. */
export const SUMMARY_SYSTEM_PROMPT =
	"You name cmux terminal tabs and workspaces based on the first user request in a coding-agent session.\n" +
	"Output a single JSON object exactly of the form {\"tab\":\"...\",\"workspace\":\"...\"} and nothing else.\n" +
	"Rules:\n" +
	'- "tab": 2-5 words, Title Case, specific enough that the user can distinguish tabs (e.g. "Add CMux Status Extension").\n' +
	'- "workspace": 1-3 words, Title Case, broader theme (e.g. "Pi Extensions", "Backend API", "Mobile App").\n' +
	"- No quotes, no emojis, no trailing punctuation.\n" +
	"- No leading verbs like \"Help with\" or \"Fix\" — just the thing itself.\n" +
	"- If the request is a single word like \"hi\", still produce something reasonable (e.g. tab: \"Chat\", workspace: \"Chat\").";

/** Cap prompt length we ship to the summariser — a gist is enough. */
export const MAX_PROMPT_CHARS = 2000;

/** Token budget for the summary completion. */
export const SUMMARY_MAX_TOKENS = 120;

/**
 * Extract a `{tab, workspace}` pair from arbitrary model output. Finds the
 * first `{...}` JSON object in the text and validates its shape; tolerates
 * surrounding prose, stray trailing text, or a missing field (as long as
 * at least one of `tab` / `workspace` is non-empty, the other is filled in
 * from the present one).
 *
 * Returns `undefined` when no usable object could be parsed.
 */
export function parseNames(raw: string | undefined | null): Names | undefined {
	if (!raw) return undefined;
	const match = raw.match(/\{[\s\S]*\}/);
	if (!match) return undefined;
	try {
		const obj = JSON.parse(match[0]) as Record<string, unknown>;
		const tab = typeof obj["tab"] === "string" ? (obj["tab"] as string).trim() : "";
		const workspace =
			typeof obj["workspace"] === "string"
				? (obj["workspace"] as string).trim()
				: "";
		if (!tab && !workspace) return undefined;
		return { tab: tab || workspace, workspace: workspace || tab };
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
 * Call the summariser model and return tab + workspace names, or
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

	const trimmed =
		firstPrompt.length > MAX_PROMPT_CHARS
			? firstPrompt.slice(0, MAX_PROMPT_CHARS)
			: firstPrompt;

	const text = await completion(
		model,
		trimmed,
		{ apiKey: auth.apiKey, headers: auth.headers },
		{ systemPrompt: SUMMARY_SYSTEM_PROMPT, maxTokens: SUMMARY_MAX_TOKENS },
	);
	return parseNames(text);
}
