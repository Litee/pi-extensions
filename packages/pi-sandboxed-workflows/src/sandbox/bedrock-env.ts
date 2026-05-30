/**
 * Bedrock environment helper for workflow scripts that drive Claude Code (or
 * any AWS-Bedrock-backed agent) inside a sandbox.
 *
 * Ported verbatim from the loop-demo orchestrator
 * (`/Volumes/workplace/2026-05/2026-05-13-research-sandcastle/loop-demo/orchestrator/lib/bedrock-env.ts`,
 * authored by the maintainer of this repo). The framework itself does NOT
 * call this helper — it is exposed to workflow files via
 * `host.sandbox.getBedrockEnv` so workflows that opt into Bedrock can produce
 * sandbox-ready credentials without re-implementing the AWS plumbing.
 *
 * The host-side AWS profile may use credential_process / SSO / ada / IMDS;
 * this function resolves everything to plain access-key/session-token env
 * vars so the sandbox does not need any AWS config inside it.
 *
 * `AWS_PROFILE` is intentionally NOT included: when both `AWS_PROFILE` and
 * `AWS_ACCESS_KEY_ID` are present, Claude Code's AWS SDK setup picks the
 * profile and then fails because the sandbox has no `~/.aws/credentials`.
 */
import { execFileSync } from "node:child_process";

export interface BedrockEnvOptions {
	/** AWS profile name on the host (e.g. "dev-ai"). */
	readonly profile: string;
	/** AWS region (e.g. "us-west-2"). */
	readonly region: string;
	/**
	 * Path to prepend to PATH inside the sandbox. Use this to point at a
	 * non-cmux claude binary (the cmux shim injects flags that need cmux
	 * state). Pass a directory containing the real `claude` executable.
	 */
	readonly claudeBinDir?: string;
}

interface ExportedCredentials {
	readonly AccessKeyId: string;
	readonly SecretAccessKey: string;
	readonly SessionToken?: string;
}

/**
 * Resolve AWS credentials from a named profile and return env vars suitable
 * for Claude Code → Bedrock inside a sandbox.
 */
export function getBedrockEnv(opts: BedrockEnvOptions): Record<string, string> {
	const out = execFileSync(
		"aws",
		["configure", "export-credentials", "--profile", opts.profile],
		{ encoding: "utf8" },
	);
	const c = JSON.parse(out) as ExportedCredentials;
	const env: Record<string, string> = {
		AWS_ACCESS_KEY_ID: c.AccessKeyId,
		AWS_SECRET_ACCESS_KEY: c.SecretAccessKey,
		...(c.SessionToken !== undefined ? { AWS_SESSION_TOKEN: c.SessionToken } : {}),
		AWS_REGION: opts.region,
		CLAUDE_CODE_USE_BEDROCK: "1",
		DISABLE_TELEMETRY: "1",
		DISABLE_ERROR_REPORTING: "1",
		// Tell Claude Code we're already inside an OS sandbox so it does NOT
		// wrap each Bash tool call in its own sandbox-exec.
		IS_SANDBOX: "1",
	};
	if (opts.claudeBinDir !== undefined) {
		env["PATH"] = `${opts.claudeBinDir}:${process.env["PATH"] ?? "/usr/bin:/bin"}`;
	}
	return env;
}

/**
 * Resolve the path to the real Claude Code binary, preferring the first
 * non-cmux entry in `which -a claude`. The cmux-shipped wrapper at
 * `/Applications/cmux.app/.../bin/claude` injects `--session-id` /
 * `--settings` flags that need a live cmux socket and break headless
 * invocations.
 */
export function findRealClaudeBinDir(): string {
	const out = execFileSync("sh", ["-c", "which -a claude"], { encoding: "utf8" });
	const candidates = out
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	for (const c of candidates) {
		if (!c.includes("cmux.app")) {
			return c.replace(/\/claude$/, "");
		}
	}
	throw new Error(
		"No non-cmux 'claude' binary found in PATH. Install via 'mise use node@lts && npm i -g @anthropic-ai/claude-code'.",
	);
}
