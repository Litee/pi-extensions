/**
 * Sandbox helpers.
 *
 * Public surface (re-exported to workflow scripts via `host.sandbox`):
 *   - `srt`       — Anthropic Sandbox Runtime (macOS Seatbelt / Linux bubblewrap).
 *   - `noSandbox` — No-isolation provider (exec's directly on host).
 *   - `fake`      — In-process fake provider for unit tests.
 *
 * Internal (used by host.ts to build the default sandbox):
 *   - `getBedrockEnv` / `findRealClaudeBinDir` from bedrock-env.ts.
 *     NOT re-exported onto the public WorkflowContext.sandbox surface.
 */
export { srt, type SrtOptions } from "./srt.js";
export { noSandbox, type NoSandboxOptions } from "./noSandbox.js";
export {
	fake,
	type FakeSandboxOptions,
	type FakeResponse,
	type FakeCall,
	type FakeSandboxProvider,
} from "./fake.js";
// Internal — consumed by host.ts only. Not on the public WorkflowContext surface.
export {
	getBedrockEnv,
	findRealClaudeBinDir,
	type BedrockEnvOptions,
} from "./bedrock-env.js";
