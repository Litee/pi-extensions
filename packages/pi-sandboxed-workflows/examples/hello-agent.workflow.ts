/**
 * hello-agent.workflow.ts — manual smoke test for host.runAgent.
 *
 * Copy to ~/.pi/agent/sandboxed-workflows/hello-agent.workflow.ts
 * and run with:
 *
 *   /workflow:hello-agent "What is the capital of France?"
 *
 * Prerequisites:
 *   - AWS_PROFILE env var set to a Bedrock-enabled profile (default: dev-ai).
 *   - AWS_REGION env var set (default: us-west-2).
 *   - The profile must have permission to call
 *     bedrock:InvokeModel on the claude model.
 *
 * What it does:
 *   1. Plain text call: ask the question, publish the answer.
 *   2. Structured call: ask for a JSON response with { capital, country },
 *      validate the schema, publish the result.
 *
 * This file is intentionally NOT executed in automated tests.
 * Run it manually to verify Bedrock connectivity end-to-end.
 */
import type { WorkflowContext, AgentMeta } from "pi-sandboxed-workflows";

export default async function helloAgent(
	host: WorkflowContext,
): Promise<void> {
	const question = host.args || "What is the capital of France?";

	host.publishStatusUpdate({ kind: "started", message: `Running hello-agent: ${question}` });

	// ── 1. Plain text call ────────────────────────────────────────────────────
	host.publishStatusUpdate({ kind: "step", message: "Calling host.runAgent (plain text)…" });

	let totalTurns = 0;
	let totalInput = 0;
	let totalOutput = 0;
	const track = (meta: AgentMeta): void => {
		totalTurns += meta.turns;
		totalInput += meta.usage?.input ?? 0;
		totalOutput += meta.usage?.output ?? 0;
	};

	const text = await host.runAgent(question, { onComplete: track });

	host.publishStatusUpdate({
		kind: "agent-answer",
		message: `Plain text answer: ${String(text)}`,
	});

	// ── 2. Structured call ────────────────────────────────────────────────────
	host.publishStatusUpdate({
		kind: "step",
		message: "Calling host.runAgent with schema (structured output)…",
	});

	interface CapitalAnswer {
		capital: string;
		country: string;
	}

	const schema = {
		type: "object",
		properties: {
			capital: { type: "string", description: "Name of the capital city." },
			country: {
				type: "string",
				description: "Name of the country this capital belongs to.",
			},
		},
		required: ["capital", "country"],
		additionalProperties: false,
	};

	const structured = await host.runAgent<CapitalAnswer>(
		`Answer this question and return only JSON: ${question}`,
		{ schema, label: "capital-finder", retries: 2, onComplete: track },
	);

	host.publishStatusUpdate({
		kind: "agent-structured",
		message: `Structured answer: capital=${structured.capital}, country=${structured.country}`,
		details: { structured },
	});

	host.publishStatusUpdate({ kind: "completed", message: `hello-agent done ✓  (${String(totalTurns)} turns, in=${String(totalInput)} out=${String(totalOutput)} tokens)` });
}
