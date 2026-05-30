/**
 * `/workflow:hello [name]` — minimal sanity-check workflow.
 *
 * Publishes two lifecycle events and exits. No sandboxing, no agents, no
 * filesystem mutation. Useful for verifying the framework is wired up end
 * to end (discovery → command registration → workflow load → publish →
 * renderer → chat).
 */
import type { WorkflowContext } from "pi-sandboxed-workflows";

export default async function hello(host: WorkflowContext): Promise<void> {
	const target = host.args.trim() === "" ? "world" : host.args.trim();
	host.publishStatusUpdate({
		kind: "greeting",
		message: `Hello, ${target}!`,
		details: { target },
	});
	// Tiny await so the kind:"completed" lifecycle event from the framework
	// arrives after our greeting in the chat (publish is queued via
	// `deliverAs: "nextTurn"` so order matches publish order).
	await new Promise((resolve) => setTimeout(resolve, 25));
}
