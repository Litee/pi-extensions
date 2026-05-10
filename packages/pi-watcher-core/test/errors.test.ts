import { describe, expect, it } from "vitest";

import { makeWatcherErrors } from "../src/errors.js";

describe("makeWatcherErrors", () => {
	it("generated_class_names_include_the_label", () => {
		// Arrange / Act
		const { WatcherError, AuthError, ThrottleError, NotFoundError } =
			makeWatcherErrors("Ticket");

		// Assert
		expect(new WatcherError("e", "m").name).toBe("TicketWatcherError");
		expect(new AuthError("e", "m").name).toBe("TicketAuthError");
		expect(new ThrottleError("e", "m").name).toBe("TicketThrottleError");
		expect(new NotFoundError("e", "m").name).toBe("TicketNotFoundError");
	});

	it("errorType_property_is_set_from_first_constructor_argument", () => {
		// Arrange / Act
		const { WatcherError, AuthError, ThrottleError, NotFoundError } =
			makeWatcherErrors("X");
		const we = new WatcherError("AuthFailure", "expired");
		const ae = new AuthError("SessionExpired", "html page");
		const te = new ThrottleError("Throttled", "slow down");
		const ne = new NotFoundError("NotFound", "missing");

		// Assert
		expect(we.errorType).toBe("AuthFailure");
		expect(ae.errorType).toBe("SessionExpired");
		expect(te.errorType).toBe("Throttled");
		expect(ne.errorType).toBe("NotFound");
	});

	it("message_prefixes_errorType_with_colon", () => {
		// Arrange / Act
		const { WatcherError } = makeWatcherErrors("X");
		const e = new WatcherError("SomeType", "detail here");

		// Assert
		expect(e.message).toBe("SomeType: detail here");
	});

	it("instanceof_chain__AuthError_extends_WatcherError", () => {
		// Arrange
		const { WatcherError, AuthError } = makeWatcherErrors("Pipes");
		const e = new AuthError("auth", "expired");

		// Assert
		expect(e).toBeInstanceOf(WatcherError);
		expect(e).toBeInstanceOf(AuthError);
		expect(e).toBeInstanceOf(Error);
	});

	it("instanceof_chain__ThrottleError_extends_WatcherError", () => {
		// Arrange
		const { WatcherError, ThrottleError } = makeWatcherErrors("Pipes");
		const e = new ThrottleError("throttled", "slow down");

		// Assert
		expect(e).toBeInstanceOf(WatcherError);
		expect(e).toBeInstanceOf(ThrottleError);
	});

	it("instanceof_chain__NotFoundError_extends_WatcherError", () => {
		// Arrange
		const { WatcherError, NotFoundError } = makeWatcherErrors("Pipes");
		const e = new NotFoundError("not_found", "missing");

		// Assert
		expect(e).toBeInstanceOf(WatcherError);
		expect(e).toBeInstanceOf(NotFoundError);
	});

	it("AuthError_is_not_instanceof_ThrottleError", () => {
		// Arrange
		const { AuthError, ThrottleError } = makeWatcherErrors("X");
		const e = new AuthError("auth", "msg");

		// Assert — sibling classes must not bleed into each other
		expect(e).not.toBeInstanceOf(ThrottleError);
	});

	it("two_calls_with_different_labels_produce_independent_class_hierarchies", () => {
		// Arrange
		const ticketErrors = makeWatcherErrors("Ticket");
		const criticErrors = makeWatcherErrors("Critic");

		const ticketAuth = new ticketErrors.AuthError("auth", "expired");
		const criticBase = new criticErrors.WatcherError("e", "m");

		// Assert — ticket auth should not be instanceof critic base
		expect(ticketAuth).not.toBeInstanceOf(criticErrors.WatcherError);
		expect(criticBase).not.toBeInstanceOf(ticketErrors.WatcherError);
	});
});
