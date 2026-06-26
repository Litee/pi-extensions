/**
 * Follow-up message content and custom-type constant for the consolidation
 * trigger injected into the pi session.
 *
 * No pi/runtime imports — fully unit-testable in isolation.
 */

/** The customType value used when sending the consolidation follow-up. */
export const CONSOLIDATE_MESSAGE_TYPE = "pi-continual-learning:consolidate";

/**
 * Returns the content of the follow-up message that tells the agent to run
 * the continual-learning skill.
 */
export function buildConsolidationMessage(): string {
	return (
		"Run the continual-learning skill to mine recent session history and " +
		"update AGENTS.md with durable learned preferences and workspace facts. " +
		"You can invoke it via `/skill:continual-learning`."
	);
}
