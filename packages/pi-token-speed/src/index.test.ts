/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unnecessary-type-assertion */
import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

describe("index.ts — extension entry point", () => {
	it("registers the tps command", async () => {
		const registerCommand = vi.fn();
		const pi: Partial<ExtensionAPI> = {
			registerCommand,
			on: vi.fn(),
		};
		const mod = await import("./index.js");
		const fn = mod.default as (pi: ExtensionAPI) => void;
		fn(pi as ExtensionAPI);
		expect(registerCommand).toHaveBeenCalledWith("tps", expect.objectContaining({
			description: expect.stringContaining("display mode"),
		}));
	});

	it("subscribes to session_start event", async () => {
		const on = vi.fn();
		const pi: Partial<ExtensionAPI> = {
			registerCommand: vi.fn(),
			on,
		};
		const mod = await import("./index.js");
		const fn = mod.default as (pi: ExtensionAPI) => void;
		fn(pi as ExtensionAPI);
		expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
	});

	it("subscribes to session_shutdown event", async () => {
		const on = vi.fn();
		const pi: Partial<ExtensionAPI> = {
			registerCommand: vi.fn(),
			on,
		};
		const mod = await import("./index.js");
		const fn = mod.default as (pi: ExtensionAPI) => void;
		fn(pi as ExtensionAPI);
		expect(on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
	});

	it("subscribes to message_start event", async () => {
		const on = vi.fn();
		const pi: Partial<ExtensionAPI> = {
			registerCommand: vi.fn(),
			on,
		};
		const mod = await import("./index.js");
		const fn = mod.default as (pi: ExtensionAPI) => void;
		fn(pi as ExtensionAPI);
		expect(on).toHaveBeenCalledWith("message_start", expect.any(Function));
	});

	it("subscribes to message_update event", async () => {
		const on = vi.fn();
		const pi: Partial<ExtensionAPI> = {
			registerCommand: vi.fn(),
			on,
		};
		const mod = await import("./index.js");
		const fn = mod.default as (pi: ExtensionAPI) => void;
		fn(pi as ExtensionAPI);
		expect(on).toHaveBeenCalledWith("message_update", expect.any(Function));
	});

	it("subscribes to agent_end event", async () => {
		const on = vi.fn();
		const pi: Partial<ExtensionAPI> = {
			registerCommand: vi.fn(),
			on,
		};
		const mod = await import("./index.js");
		const fn = mod.default as (pi: ExtensionAPI) => void;
		fn(pi as ExtensionAPI);
		expect(on).toHaveBeenCalledWith("agent_end", expect.any(Function));
	});

	it("registers all 5 expected event subscriptions", async () => {
		const on = vi.fn();
		const pi: Partial<ExtensionAPI> = {
			registerCommand: vi.fn(),
			on,
		};
		const mod = await import("./index.js");
		const fn = mod.default as (pi: ExtensionAPI) => void;
		fn(pi as ExtensionAPI);
		const events = on.mock.calls.map((call) => call[0] as string);
		expect(events).toContain("session_start");
		expect(events).toContain("session_shutdown");
		expect(events).toContain("message_start");
		expect(events).toContain("message_update");
		expect(events).toContain("agent_end");
	});
});
