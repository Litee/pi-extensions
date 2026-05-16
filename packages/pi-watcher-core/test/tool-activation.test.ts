import { describe, it, expect } from "vitest";
import {
	reconcileToolActivation,
	addToolToActive,
	removeToolFromActive,
	syncToolActiveState,
	type PiToolsLike,
} from "../src/tool-activation.js";

function makePi(initial: string[] = []): PiToolsLike & { readonly active: string[] } {
	const state = { active: [...initial] };
	return {
		get active() { return state.active; },
		getActiveTools: () => state.active,
		setActiveTools: (tools: string[]) => {
			state.active = [...tools];
		},
	};
}

describe("reconcileToolActivation", () => {
	it("returns 'activate' when tool is active but enabled=false", () => {
		expect(reconcileToolActivation("my_tool", false, ["my_tool", "other"])).toBe("activate");
	});

	it("returns 'deactivate' when tool is inactive but enabled=true", () => {
		expect(reconcileToolActivation("my_tool", true, ["other"])).toBe("deactivate");
	});

	it("returns 'noop' when tool is active and enabled=true", () => {
		expect(reconcileToolActivation("my_tool", true, ["my_tool"])).toBe("noop");
	});

	it("returns 'noop' when tool is inactive and enabled=false", () => {
		expect(reconcileToolActivation("my_tool", false, ["other"])).toBe("noop");
	});
});

describe("addToolToActive", () => {
	it("adds the tool when absent", () => {
		const pi = makePi(["a", "b"]);
		addToolToActive(pi, "my_tool");
		expect(pi.active).toContain("my_tool");
	});

	it("is idempotent — no duplicate when already present", () => {
		const pi = makePi(["my_tool"]);
		addToolToActive(pi, "my_tool");
		expect(pi.active.filter((t) => t === "my_tool")).toHaveLength(1);
	});
});

describe("removeToolFromActive", () => {
	it("removes the tool when present", () => {
		const pi = makePi(["my_tool", "other"]);
		removeToolFromActive(pi, "my_tool");
		expect(pi.active).not.toContain("my_tool");
		expect(pi.active).toContain("other");
	});

	it("is idempotent — no error when already absent", () => {
		const pi = makePi(["other"]);
		expect(() => removeToolFromActive(pi, "my_tool")).not.toThrow();
		expect(pi.active).toEqual(["other"]);
	});
});

describe("syncToolActiveState", () => {
	it("adds the tool when enabled=true", () => {
		const pi = makePi(["other"]);
		syncToolActiveState(pi, "my_tool", true);
		expect(pi.active).toContain("my_tool");
	});

	it("removes the tool when enabled=false", () => {
		const pi = makePi(["my_tool", "other"]);
		syncToolActiveState(pi, "my_tool", false);
		expect(pi.active).not.toContain("my_tool");
	});
});
