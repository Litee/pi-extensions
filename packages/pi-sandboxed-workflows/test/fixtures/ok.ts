/**
 * Fixture workflow that publishes three events then resolves.
 * Used by runtime.test.ts to verify the framework forwards every event.
 */
import type { WorkflowContext } from "../../src/types.js";

export default async function (host: WorkflowContext): Promise<void> {
	host.publishStatusUpdate({ kind: "step", message: "step 1", details: { i: 1 } });
	host.publishStatusUpdate({ kind: "step", message: "step 2", details: { i: 2 } });
	host.publishStatusUpdate({ kind: "step", message: "step 3", details: { i: 3 } });
	await Promise.resolve();
}
