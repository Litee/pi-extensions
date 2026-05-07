/**
 * Format a list of tool names for display in a notification message.
 *
 * Shows all tools when there are 10 or fewer; otherwise shows the first 10
 * and appends a "(+N more)" note so the message stays readable regardless of
 * how many tools are active.
 *
 * @example
 * formatToolList(["read", "bash", "grep"]) // "Tools: read, bash, grep"
 * formatToolList(new Array(12).fill(0).map((_,i)=>`t${i+1}`))
 * // "Tools: t1, t2, ..., t10 (12 total)"
 */
export function formatToolList(tools: string[]): string {
	const SAMPLE_SIZE = 10;
	const sample = tools.slice(0, SAMPLE_SIZE);
	const base = `Tools: ${sample.join(", ")}`;
	if (tools.length > SAMPLE_SIZE) {
		return `${base} (${tools.length} total)`;
	}
	return base;
}
