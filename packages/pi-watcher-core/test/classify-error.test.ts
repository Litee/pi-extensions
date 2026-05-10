import { describe, expect, it } from "vitest";

import { classifyWatcherError } from "../src/classify-error.js";
import { makeWatcherErrors } from "../src/errors.js";

const { WatcherError, AuthError, ThrottleError, NotFoundError } =
	makeWatcherErrors("Test");

const opts = {
	authErrorClass: AuthError,
	throttleErrorClass: ThrottleError,
	notFoundErrorClass: NotFoundError,
};

describe("classifyWatcherError", () => {
	it.each([
		{
			name: "auth_error",
			err: new AuthError("session_expired", "session expired svc.example.internal#X"),
			expectedKind: "auth" as const,
			expectedModifier: "auth-error" as const,
			expectedBackoff: true,
			expectedUserContains: "authentication",
		},
		{
			name: "throttle_error",
			err: new ThrottleError("Throttled", "slow down svc.example.internal#Throttled"),
			expectedKind: "throttle" as const,
			expectedModifier: "throttled" as const,
			expectedBackoff: true,
			expectedUserContains: "throttled",
		},
		{
			name: "not_found_error",
			err: new NotFoundError("ItemNotFoundException", "missing svc.example.internal#X"),
			expectedKind: "not_found" as const,
			expectedModifier: "none" as const,
			expectedBackoff: false,
			expectedUserContains: "not found",
		},
		{
			name: "generic_watcher_error",
			err: new WatcherError(
				"invalid_json",
				'Unexpected response: {"__type":"svc.example.internal#Oops"} <html><body>sensitive</body></html>',
			),
			expectedKind: "generic" as const,
			expectedModifier: "degraded" as const,
			expectedBackoff: false,
			expectedUserContains: "request failed",
		},
		{
			name: "non_error_value",
			err: "plain string",
			expectedKind: "generic" as const,
			expectedModifier: "degraded" as const,
			expectedBackoff: false,
			expectedUserContains: "request failed",
		},
	])(
		"classifies $name with sanitized user message",
		({ err, expectedKind, expectedModifier, expectedBackoff, expectedUserContains }) => {
			const result = classifyWatcherError(err, opts);
			expect(result.kind).toBe(expectedKind);
			expect(result.statusModifier).toBe(expectedModifier);
			expect(result.shouldBackoff).toBe(expectedBackoff);
			expect(result.userMessage).toContain(expectedUserContains);
			// user-visible message must NOT leak raw error-code discriminators,
			// hostnames, HTML bodies, or anything derived from err.message.
			expect(result.userMessage).not.toContain("svc.example.internal");
			expect(result.userMessage).not.toContain("__type");
			expect(result.userMessage).not.toContain("<html");
			expect(result.userMessage).not.toContain("sensitive");
		},
	);

	it("user_message_is_literal_default_not_derived_from_err_message", () => {
		const err = new AuthError(
			"session_expired",
			"Received HTML instead of JSON — session expired. <!DOCTYPE html>",
		);
		const result = classifyWatcherError(err, opts);
		// The default string, not anything derived from err.message.
		expect(result.userMessage).toBe("authentication expired — re-authenticate");
	});

	it("custom_messages_override_defaults", () => {
		const err = new AuthError("session_expired", "x");
		const result = classifyWatcherError(err, {
			...opts,
			authMessage: "custom auth msg",
		});
		expect(result.userMessage).toBe("custom auth msg");
	});

	it("auth_check_takes_priority_over_generic_error", () => {
		// AuthError extends WatcherError, so order matters.
		const err = new AuthError("session_expired", "y");
		const result = classifyWatcherError(err, opts);
		expect(result.kind).toBe("auth");
		expect(result.statusModifier).toBe("auth-error");
	});

	it("not_found_class_is_optional", () => {
		const err = new NotFoundError("ItemNotFoundException", "x");
		const result = classifyWatcherError(err, {
			authErrorClass: AuthError,
			throttleErrorClass: ThrottleError,
			// notFoundErrorClass omitted
		});
		// Falls through to generic classification.
		expect(result.kind).toBe("generic");
	});
});
