/**
 * Live-IO shim for the LLM summariser. Isolated here (and excluded from
 * coverage) so the pure parsing / orchestration logic in `names.ts` can
 * be unit-tested without a live model.
 *
 * `runSummaryCompletion` is the only code path that actually calls
 * `completeSimple` from `@mariozechner/pi-ai` — everything else in the
 * naming pipeline consumes its output.
 */

import { completeSimple, type Api, type Model } from "@mariozechner/pi-ai";

export interface SummaryCompletionAuth {
	apiKey: string | undefined;
	headers: Record<string, string> | undefined;
}

export interface SummaryCompletionOptions {
	systemPrompt: string;
	maxTokens: number;
}

/**
 * Call the summariser model once and return the raw text response, or
 * `undefined` on any failure (network error, aborted, non-text reply).
 * Never throws — the caller can blindly `await` it.
 */
export async function runSummaryCompletion(
	model: Model<Api>,
	prompt: string,
	auth: SummaryCompletionAuth,
	opts: SummaryCompletionOptions,
): Promise<string | undefined> {
	try {
		const simpleOptions: Parameters<typeof completeSimple>[2] = {
			maxTokens: opts.maxTokens,
		};
		if (auth.apiKey !== undefined) simpleOptions.apiKey = auth.apiKey;
		if (auth.headers !== undefined) simpleOptions.headers = auth.headers;

		const response = await completeSimple(
			model,
			{
				systemPrompt: opts.systemPrompt,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: prompt }],
						timestamp: Date.now(),
					},
				],
			},
			simpleOptions,
		);

		if (response.stopReason === "error" || response.stopReason === "aborted") {
			return undefined;
		}

		return response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();
	} catch {
		return undefined;
	}
}
