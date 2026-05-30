/**
 * `/workflow:plan-implement-review <task>` — v2 example workflow.
 *
 * Drop this file into `~/.pi/agent/sandboxed-workflows/` (or any directory
 * listed in `~/.pi/agent/pi-sandboxed-workflows.json`) and the extension will
 * register `/workflow:plan-implement-review <task>` automatically.
 *
 * Three roles, one mental model — `host.runAgent` throughout:
 *
 *   1. PLANNER      — structured output, default read-only sandbox.
 *                     Returns a typed `Plan`.
 *   2. IMPLEMENTOR  — writable srt sandbox, worktree-scoped cwd. No schema.
 *                     Pi runs the full agent loop internally.
 *   3. REVIEWER     — diff inlined into prompt, structured verdict.
 *                     Default read-only sandbox.
 *
 * Loop: planner → (implementor → reviewer)+ until APPROVED or maxRounds.
 *
 * No commits: the implementor edits files but does NOT `git commit`.
 * After approval, `cd` into the worktree to inspect, commit, or discard.
 *
 * Requirements:
 *   - macOS (srt sandbox is Seatbelt-based)
 *   - the `srt` CLI on PATH (https://github.com/anthropic-experimental/srt)
 *   - AWS credentials reachable via the AWS SDK (a profile, instance role,
 *     or static credentials). The framework calls `getBedrockEnv` once on
 *     first agent invocation and merges the result into every sandbox
 *     built via `host.createSandbox(...)` AND the default read-only sandbox.
 *     Workflow authors do NOT need to wire AWS env vars manually. Override
 *     per-call by passing `env: { ... }` to `host.createSandbox(...)`;
 *     explicit keys win on collision.
 *   - the `claude` CLI on PATH (the framework finds the real binary dir).
 */
import type { WorkflowContext } from "pi-sandboxed-workflows";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Tunables ─────────────────────────────────────────────────────────────────
const MAX_ROUNDS = Number(process.env["WORKFLOW_PIR_MAX_ROUNDS"] ?? "3");
const REGION = process.env["AWS_REGION"] ?? "us-west-2";

const BEDROCK_DOMAINS = [
	`bedrock-runtime.${REGION}.amazonaws.com`,
	"sts.amazonaws.com",
	`sts.${REGION}.amazonaws.com`,
];

// ── Schemas ───────────────────────────────────────────────────────────────────
const PLAN_SCHEMA = {
	type: "object",
	required: ["overview", "steps", "filesToTouch", "risks"],
	properties: {
		overview: {
			type: "string",
			description: "1–2 sentences describing the implementation strategy.",
		},
		steps: {
			type: "array",
			minItems: 1,
			maxItems: 10,
			items: { type: "string" },
			description: "Concrete actions; reference functions/modules by name.",
		},
		filesToTouch: {
			type: "array",
			items: { type: "string" },
			description: "Every file the implementor is expected to modify.",
		},
		risks: {
			type: "array",
			maxItems: 5,
			items: { type: "string" },
			description: "Top risks that could derail the plan.",
		},
	},
	additionalProperties: false,
};

interface Plan {
	overview: string;
	steps: string[];
	filesToTouch: string[];
	risks: string[];
}

const VERDICT_SCHEMA = {
	type: "object",
	required: ["verdict", "summary", "issues"],
	properties: {
		verdict: { enum: ["APPROVED", "REVISE"] },
		summary: {
			type: "string",
			description: "One-paragraph summary of the review outcome.",
		},
		issues: {
			type: "array",
			items: {
				type: "object",
				required: ["title", "severity", "description"],
				properties: {
					title: { type: "string" },
					severity: { enum: ["high", "medium", "low"] },
					description: { type: "string" },
					file: { type: "string" },
					line: { type: "number" },
				},
				additionalProperties: false,
			},
			description:
				"Empty when verdict is APPROVED. When REVISE, every issue must be " +
				"concrete and actionable.",
		},
	},
	additionalProperties: false,
};

interface VerdictIssue {
	title: string;
	severity: "high" | "medium" | "low";
	description: string;
	file?: string;
	line?: number;
}

interface Verdict {
	verdict: "APPROVED" | "REVISE";
	summary: string;
	issues: VerdictIssue[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Cheap repo overview for the planner — capped at 200 tracked files so a
 * large monorepo does not blow up the prompt.
 */
function repoContext(cwd: string): string {
	try {
		const files = execFileSync("git", ["-C", cwd, "ls-files"], {
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
		})
			.split("\n")
			.filter(Boolean);
		const head = files.slice(0, 200);
		const truncated =
			files.length > 200 ? `\n… (${files.length - 200} more files)` : "";
		return `Repo files (${files.length} tracked, showing first ${head.length}):\n${head.join("\n")}${truncated}`;
	} catch {
		return "(cwd is not a git repo, or git is unavailable)";
	}
}

function gitCommonDir(repoPath: string): string {
	const out = execFileSync(
		"git",
		["-C", repoPath, "rev-parse", "--git-common-dir"],
		{ encoding: "utf8" },
	).trim();
	return out.startsWith("/") ? out : resolve(repoPath, out);
}

// ── Workflow body ─────────────────────────────────────────────────────────────
export default async function planImplementReview(
	host: WorkflowContext,
): Promise<void> {
	const task = host.args.trim();
	if (task === "") {
		host.publishStatusUpdate({
			kind: "error",
			message: "Usage: /workflow:plan-implement-review <task description>",
		});
		return;
	}

	host.publishStatusUpdate({
		kind: "started",
		message: `Plan → Implement → Review: ${task}`,
	});

	// ── Phase 1: PLAN ─────────────────────────────────────────────────────────
	// Default sandbox: read-only srt on host.cwd, Bedrock allow-list.

	const PLANNER_PROMPT = `You are a senior engineer planning a code change.

# User task
${task}

# Repository context
Working directory: ${host.cwd}
${repoContext(host.cwd)}

# Output
Produce a tight plan as structured JSON:
- overview: 1–2 sentences describing the strategy.
- steps: ≤10 concrete actions. Reference functions/modules/files by name.
- filesToTouch: every file you expect the implementor to modify.
- risks: top 3 things that could derail this plan.

Do NOT write code. Do NOT include filler.`;

	const plan = await host.runAgent<Plan>(PLANNER_PROMPT, {
		schema: PLAN_SCHEMA,
		label: "planner",
		retries: 3,
	});

	host.publishStatusUpdate({
		kind: "plan-ready",
		message: plan.overview,
		details: {
			steps: plan.steps,
			filesToTouch: plan.filesToTouch,
			risks: plan.risks,
		},
	});

	// ── Phase 2: WORKTREE setup ───────────────────────────────────────────────
	const slug = task
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	const branch = `pi-sw/${slug}-${host.runId}`;

	await using wt = await host.createWorktree({
		cwd: host.cwd,
		branchStrategy: { type: "branch", branch },
	});

	host.publishStatusUpdate({
		kind: "worktree-ready",
		message: `Worktree: ${wt.worktreePath}`,
		details: { worktreePath: wt.worktreePath, branch: wt.branch },
	});

	// Writable srt sandbox for the implementor. The framework auto-injects
	// Bedrock credentials into every `host.createSandbox(...)` call, so we
	// don't have to wire env explicitly. The git common dir is added to
	// extraAllowWrite so git operations inside the sandbox can update refs.
	const gitDir = gitCommonDir(host.cwd);
	const writableSandbox = host.createSandbox({
		worktreeReadonly: false,
		allowedDomains: BEDROCK_DOMAINS,
		extraAllowWrite: [gitDir],
	});

	// ── Phase 3: IMPLEMENT ↔ REVIEW LOOP ─────────────────────────────────────
	const planText = JSON.stringify(plan, null, 2);
	let approved = false;
	let lastVerdict: Verdict | null = null;
	let roundsRun = 0;

	for (let round = 1; round <= MAX_ROUNDS && !approved; round += 1) {
		roundsRun = round;

		const feedbackBlock =
			lastVerdict !== null && lastVerdict.issues.length > 0
				? `\n\n# Reviewer feedback from round ${(round - 1).toString()}\n` +
					`Address every issue below:\n${JSON.stringify(lastVerdict.issues, null, 2)}\n`
				: "";

		const IMPLEMENTOR_PROMPT = `You are the IMPLEMENTOR. Round ${round.toString()}/${MAX_ROUNDS.toString()}.

# Plan to implement
${planText}
${feedbackBlock}
# Strict rules
- DO NOT run \`git add\` or \`git commit\`. Leave changes uncommitted.
- Implement EXACTLY what the plan and (if present) reviewer feedback require.
- The OS sandbox restricts writes to this worktree.

End your final message when the implementation is complete.`;

		await host.runAgent(IMPLEMENTOR_PROMPT, {
			cwd: wt.worktreePath,
			sandbox: writableSandbox,
			idleTimeoutSeconds: 900,
			label: `implementor-r${round.toString()}`,
		});

		host.publishStatusUpdate({
			kind: "implementor-done",
			message: `Round ${round.toString()}: implementor finished.`,
			details: { round },
		});

		// Capture working-tree diff for the reviewer.
		let diff: string;
		try {
			diff = execFileSync("git", ["-C", wt.worktreePath, "diff", "HEAD"], {
				encoding: "utf8",
				maxBuffer: 16 * 1024 * 1024,
			});
		} catch (err) {
			host.publishStatusUpdate({
				kind: "error",
				message: `Failed to read diff: ${err instanceof Error ? err.message : String(err)}`,
			});
			return;
		}

		if (diff.trim() === "") {
			host.publishStatusUpdate({
				kind: "error",
				message: `Round ${round.toString()}: implementor produced no diff.`,
			});
			return;
		}

		// Reviewer — diff inlined into prompt; default sandbox (read-only on host.cwd).
		const REVIEWER_PROMPT = `You are an adversarial code reviewer. Be skeptical.

# Plan that was supposed to be implemented
${planText}

# Diff produced by the implementor
\`\`\`diff
${diff}
\`\`\`

# Output
Return a structured verdict:
- verdict: "APPROVED" only if every plan step is implemented correctly AND no obvious bugs are present. Otherwise "REVISE".
- summary: one paragraph summarising the change and your judgement.
- issues: when REVISE, list every concrete issue. Each must have title, severity, and a description that names the file (and line if known). When APPROVED, return an empty array.

Default to REVISE if anything is unclear.`;

		const verdict = await host.runAgent<Verdict>(REVIEWER_PROMPT, {
			schema: VERDICT_SCHEMA,
			label: `reviewer-r${round.toString()}`,
			retries: 3,
		});

		lastVerdict = verdict;
		host.publishStatusUpdate({
			kind: "reviewer-done",
			message: `Round ${round.toString()} verdict: ${verdict.verdict} — ${verdict.summary}`,
			details: { round, verdict: verdict.verdict, issues: verdict.issues },
		});

		if (verdict.verdict === "APPROVED") {
			approved = true;
		}
	}

	// ── Phase 4: SUMMARY ──────────────────────────────────────────────────────
	if (approved) {
		host.publishStatusUpdate({
			kind: "approved",
			message:
				`APPROVED in ${roundsRun.toString()} round(s). ` +
				`Worktree at ${wt.worktreePath} (uncommitted).`,
			details: {
				worktreePath: wt.worktreePath,
				branch: wt.branch,
				rounds: roundsRun,
			},
		});
		writeFileSync(
			join(wt.worktreePath, ".pi-summary.md"),
			[
				`# /workflow:plan-implement-review summary`,
				``,
				`Task: ${task}`,
				`Branch: ${wt.branch}`,
				`Rounds: ${roundsRun.toString()}`,
				``,
				`## Plan overview`,
				``,
				plan.overview,
				``,
				`## Steps`,
				``,
				...plan.steps.map((s, i) => `${(i + 1).toString()}. ${s}`),
				``,
				`## Files touched (planned)`,
				``,
				...plan.filesToTouch.map((f) => `- ${f}`),
				``,
				`## Final reviewer summary`,
				``,
				lastVerdict?.summary ?? "(no summary)",
			].join("\n"),
		);
	} else {
		host.publishStatusUpdate({
			kind: "rejected",
			message: `Not approved after ${roundsRun.toString()} round(s).`,
			details: {
				worktreePath: wt.worktreePath,
				rounds: roundsRun,
				lastIssues: lastVerdict?.issues ?? [],
			},
		});
	}
}
