/**
 * Fixture workflow that throws. Used to verify error propagation.
 */
import type { WorkflowContext } from "../../src/types.js";

// eslint-disable-next-line @typescript-eslint/require-await -- the framework awaits this; throwing synchronously would also work.
export default async function (_host: WorkflowContext): Promise<void> {
	throw new Error("boom");
}
