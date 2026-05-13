/**
 * Pure ESC-sequence scanner for DECSET ?1004 focus reporting.
 *
 * `process.stdin` is a flowing binary stream; the terminal can split a
 * 3-byte focus sequence (`ESC [ I` / `ESC [ O`) across chunk boundaries.
 * `feedFocusBytes` buffers any trailing unconsumed bytes so the next call
 * can complete a straddled sequence. Completed sequences are emitted to
 * `events` and their bytes are dropped from `rest`.
 *
 * Callers own the buffer: pass last call's `rest` back in as `buf` on the
 * next call. This makes the function trivially unit-testable and keeps
 * the stateful `index.ts` focus listener to a ~5-line closure.
 */

const FOCUS_IN_SEQ = "\x1b[I";
const FOCUS_OUT_SEQ = "\x1b[O";
const MAX_SEQ = Math.max(FOCUS_IN_SEQ.length, FOCUS_OUT_SEQ.length);

/** Upper bound on the carry-over buffer; matches the safety net below. */
const BUF_SAFETY_CAP = 64;

export type FocusEvent = "in" | "out";

export function feedFocusBytes(
	buf: string,
	chunk: string,
): { events: FocusEvent[]; rest: string } {
	const work = buf + chunk;
	const events: FocusEvent[] = [];
	let i = 0;
	while (i + MAX_SEQ <= work.length) {
		if (work.startsWith(FOCUS_IN_SEQ, i)) {
			events.push("in");
			i += FOCUS_IN_SEQ.length;
		} else if (work.startsWith(FOCUS_OUT_SEQ, i)) {
			events.push("out");
			i += FOCUS_OUT_SEQ.length;
		} else {
			i++;
		}
	}
	let rest = work.slice(i);
	if (rest.length > BUF_SAFETY_CAP) rest = rest.slice(-(MAX_SEQ - 1));
	void work;
	return { events, rest };
}
