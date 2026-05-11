/**
 * Error classifier for watcher extensions.
 *
 * Callers supply up to three optional predicate functions — `authPredicate`,
 * `throttlePredicate`, and `notFoundPredicate` — each with the signature
 * `(err: unknown) => boolean`. When an error matches a predicate it is
 * mapped to the corresponding safe user message and status modifier.
 *
 * Errors that escape into user-visible paths (chat transcript, tool
 * response, `ctx.ui.notify`, or `pi.appendEntry` payload) MUST NOT echo the
 * raw `err.message`, because it can embed service-specific error
 * discriminators, internal hostnames, request ids, and — when the upstream
 * service returns HTML or a partial body on a parse failure — raw response
 * bytes.
 *
 * This classifier collapses any error into a small set of known-safe
 * human-readable strings plus a `statusModifier` that the caller can mirror
 * into the watcher's status line (matching the `pollOnce` behaviour) and a
 * `shouldBackoff` hint for the poll scheduler.
 *
 * Security guarantee: NONE of the returned strings are derived from
 * `err.message` — they are literal defaults or caller-provided
 * `customMessage` overrides. Callers can therefore pass the output directly
 * to `ctx.ui.notify`, `pi.appendEntry`, tool-response `content` / `details`
 * fields, or any other user-visible surface without sanitization.
 */

export type WatcherStatusModifier =
	| "auth-error"
	| "throttled"
	| "degraded"
	| "none";

export interface ClassifiedWatcherError {
	/** Safe for chat / tool-response content. Never contains raw server body. */
	userMessage: string;
	/** Short classifier tag, suitable for structured log payloads. */
	kind: "auth" | "throttle" | "not_found" | "generic";
	/** Mirrors the modifier that `pollOnce` would set on this error. */
	statusModifier: WatcherStatusModifier;
	/** Caller should invoke `scheduler.noteBackoff()` when true. */
	shouldBackoff: boolean;
}

export interface ClassifyErrorOptions {
	authPredicate?: (err: unknown) => boolean;
	throttlePredicate?: (err: unknown) => boolean;
	notFoundPredicate?: (err: unknown) => boolean;
	/** Defaults to 'authentication expired — re-authenticate'. */
	authMessage?: string;
	/** Defaults to 'service throttled — will retry'. */
	throttleMessage?: string;
	/** Defaults to 'resource not found'. */
	notFoundMessage?: string;
	/** Defaults to 'request failed'. */
	genericMessage?: string;
}

const DEFAULT_AUTH = "authentication expired — re-authenticate";
const DEFAULT_THROTTLE = "service throttled — will retry";
const DEFAULT_NOT_FOUND = "resource not found";
const DEFAULT_GENERIC = "request failed";

export function classifyWatcherError(
	err: unknown,
	opts: ClassifyErrorOptions,
): ClassifiedWatcherError {
	if (opts.authPredicate?.(err)) {
		return {
			userMessage: opts.authMessage ?? DEFAULT_AUTH,
			kind: "auth",
			statusModifier: "auth-error",
			shouldBackoff: true,
		};
	}
	if (opts.throttlePredicate?.(err)) {
		return {
			userMessage: opts.throttleMessage ?? DEFAULT_THROTTLE,
			kind: "throttle",
			statusModifier: "throttled",
			shouldBackoff: true,
		};
	}
	if (opts.notFoundPredicate?.(err)) {
		return {
			userMessage: opts.notFoundMessage ?? DEFAULT_NOT_FOUND,
			kind: "not_found",
			statusModifier: "none",
			shouldBackoff: false,
		};
	}
	return {
		userMessage: opts.genericMessage ?? DEFAULT_GENERIC,
		kind: "generic",
		statusModifier: "degraded",
		shouldBackoff: false,
	};
}
