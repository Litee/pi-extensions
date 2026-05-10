/**
 * Error-taxonomy factory for pi watcher extensions.
 *
 * Every watcher package repeats the same three-level hierarchy:
 *   BaseError → AuthError (auth / session expiry)
 *             → ThrottleError (rate limiting)
 *             → NotFoundError (resource missing, optional)
 *
 * `makeWatcherErrors("Ticket")` produces `{ WatcherError, AuthError,
 * ThrottleError, NotFoundError }` where each subclass extends WatcherError,
 * so `instanceof WatcherError` checks work on any error in the family.
 *
 * All generated classes carry a readonly `errorType: string` property
 * mirroring the Python reference implementations.
 */

export interface WatcherErrorClasses {
	WatcherError: new (errorType: string, message: string) => Error & {
		readonly errorType: string;
	};
	AuthError: new (errorType: string, message: string) => Error & {
		readonly errorType: string;
	};
	ThrottleError: new (errorType: string, message: string) => Error & {
		readonly errorType: string;
	};
	NotFoundError: new (errorType: string, message: string) => Error & {
		readonly errorType: string;
	};
}

/**
 * Generate a family of watcher error classes namespaced under `label`.
 *
 * Example: `makeWatcherErrors("Critic")` produces classes named
 * `"CriticWatcherError"`, `"CriticAuthError"`, `"CriticThrottleError"`,
 * `"CriticNotFoundError"`.
 */
export function makeWatcherErrors(label: string): WatcherErrorClasses {
	class WatcherError extends Error {
		readonly errorType: string;
		constructor(errorType: string, message: string) {
			super(`${errorType}: ${message}`);
			this.name = `${label}WatcherError`;
			this.errorType = errorType;
		}
	}

	class AuthError extends WatcherError {
		constructor(errorType: string, message: string) {
			super(errorType, message);
			this.name = `${label}AuthError`;
		}
	}

	class ThrottleError extends WatcherError {
		constructor(errorType: string, message: string) {
			super(errorType, message);
			this.name = `${label}ThrottleError`;
		}
	}

	class NotFoundError extends WatcherError {
		constructor(errorType: string, message: string) {
			super(errorType, message);
			this.name = `${label}NotFoundError`;
		}
	}

	return { WatcherError, AuthError, ThrottleError, NotFoundError };
}
