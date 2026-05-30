/**
 * Fixture workflow that resolves only when its host.signal is aborted.
 * Used to verify cancellation and concurrency behaviour.
 *
 * Defensive against race: if the signal is already aborted by the time the
 * promise body runs, resolves immediately rather than missing the event.
 */
import type { WorkflowContext } from "../../src/types.js";

export default function (host: WorkflowContext): Promise<void> {
	host.publishStatusUpdate({ kind: "started", message: "waiting for abort" });
	return new Promise<void>((resolve) => {
		if (host.signal.aborted) {
			resolve();
			return;
		}
		host.signal.addEventListener("abort", () => resolve(), { once: true });
	});
}
