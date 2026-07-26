import { describe, expect, it, vi } from "vitest";

import { isInsideHerdr, renameWorkspace, resolveWorkspaceId } from "../src/herdr.js";
import type { ExecFn } from "../src/herdr.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PANE_GET_JSON = JSON.stringify({
	id: "cli:pane:get",
	result: {
		pane: {
			agent: "pi",
			agent_status: "working",
			cwd: "/some/path",
			focused: false,
			pane_id: "w652f1910e89a56-1",
			revision: 0,
			tab_id: "w652f1910e89a56:1",
			terminal_id: "term_652f1910e899f6",
			workspace_id: "w652f1910e89a56",
		},
		type: "pane_info",
	},
});

type MockExecFn = ReturnType<typeof vi.fn> & ExecFn;

function makeExec(
	impl?: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>,
): MockExecFn {
	return (impl
		? vi.fn(impl)
		: vi.fn().mockResolvedValue({ code: 0, stdout: PANE_GET_JSON, stderr: "" })) as MockExecFn;
}

// ---------------------------------------------------------------------------
// isInsideHerdr
// ---------------------------------------------------------------------------

describe("isInsideHerdr", () => {
	it("returns true when HERDR_ENV === '1'", () => {
		expect(isInsideHerdr({ HERDR_ENV: "1" })).toBe(true);
	});

	it("returns false when HERDR_ENV is absent", () => {
		expect(isInsideHerdr({})).toBe(false);
	});

	it("returns false when HERDR_ENV is any other value", () => {
		expect(isInsideHerdr({ HERDR_ENV: "0" })).toBe(false);
		expect(isInsideHerdr({ HERDR_ENV: "true" })).toBe(false);
		expect(isInsideHerdr({ HERDR_ENV: "" })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// resolveWorkspaceId
// ---------------------------------------------------------------------------

describe("resolveWorkspaceId", () => {
	it("calls herdr pane get with HERDR_PANE_ID and returns workspace_id", async () => {
		const exec = makeExec();
		const id = await resolveWorkspaceId(exec, { HERDR_PANE_ID: "p_6" });
		expect(id).toBe("w652f1910e89a56");
		expect(exec.mock.calls[0]?.[0]).toBe("herdr");
		expect(exec.mock.calls[0]?.[1]).toEqual(["pane", "get", "p_6"]);
		expect(exec.mock.calls[0]?.[2]).toEqual({ timeout: 5000 });
	});

	it("passes timeout option to exec", async () => {
		const exec = makeExec();
		await resolveWorkspaceId(exec, { HERDR_PANE_ID: "p_6" });
		expect(exec.mock.calls[0]?.[2]).toEqual({ timeout: 5000 });
	});

	it("returns null when HERDR_PANE_ID is absent", async () => {
		const exec = makeExec();
		const id = await resolveWorkspaceId(exec, {});
		expect(id).toBeNull();
		// Should not even call exec — no pane ID to query
		expect(exec).not.toHaveBeenCalled();
	});

	it("returns null when exec throws", async () => {
		const exec = makeExec(() => { throw new Error("herdr not found"); });
		const id = await resolveWorkspaceId(exec, { HERDR_PANE_ID: "p_6" });
		expect(id).toBeNull();
	});

	it("returns null when exec returns non-zero code", async () => {
		const exec = makeExec(() => Promise.resolve({ code: 1, stdout: "", stderr: "error" }));
		const id = await resolveWorkspaceId(exec, { HERDR_PANE_ID: "p_6" });
		expect(id).toBeNull();
	});

	it("returns null when JSON is malformed", async () => {
		const exec = makeExec(() => Promise.resolve({ code: 0, stdout: "not-json{{{", stderr: "" }));
		const id = await resolveWorkspaceId(exec, { HERDR_PANE_ID: "p_6" });
		expect(id).toBeNull();
	});

	it("returns null when workspace_id is missing from response", async () => {
		const exec = makeExec(() => Promise.resolve({
			code: 0,
			stdout: JSON.stringify({ result: { pane: {} } }),
			stderr: "",
		}));
		const id = await resolveWorkspaceId(exec, { HERDR_PANE_ID: "p_6" });
		expect(id).toBeNull();
	});

	it("returns null when workspace_id is empty string", async () => {
		const exec = makeExec(() => Promise.resolve({
			code: 0,
			stdout: JSON.stringify({ result: { pane: { workspace_id: "" } } }),
			stderr: "",
		}));
		const id = await resolveWorkspaceId(exec, { HERDR_PANE_ID: "p_6" });
		expect(id).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// renameWorkspace
// ---------------------------------------------------------------------------

describe("renameWorkspace", () => {
	it("calls exec with workspace rename args using the stable workspace_id hash", async () => {
		const exec = makeExec(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }));
		await renameWorkspace(exec, "w652f1910e89a56", "my session");
		expect(exec.mock.calls[0]?.[0]).toBe("herdr");
		expect(exec.mock.calls[0]?.[1]).toEqual(["workspace", "rename", "w652f1910e89a56", "my session"]);
		expect(exec.mock.calls[0]?.[2]).toEqual({ timeout: 5000 });
	});

	it("passes timeout option to exec", async () => {
		const exec = makeExec(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }));
		await renameWorkspace(exec, "w652f1910e89a56", "my session");
		expect(exec.mock.calls[0]?.[2]).toEqual({ timeout: 5000 });
	});

	it("returns { ok: true } on success (code 0)", async () => {
		const exec = makeExec(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }));
		const result = await renameWorkspace(exec, "w652f1910e89a56", "my session");
		expect(result).toEqual({ ok: true });
	});

	it("returns { ok: false, reason } on non-zero exit", async () => {
		const exec = makeExec(() => Promise.resolve({ code: 1, stdout: "", stderr: "workspace not found" }));
		const result = await renameWorkspace(exec, "w652f1910e89a56", "my session");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("workspace not found");
	});

	it("returns { ok: false, reason } when exec throws", async () => {
		const exec = makeExec(() => { throw new Error("command failed"); });
		const result = await renameWorkspace(exec, "w652f1910e89a56", "my session");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("command failed");
	});

	it("uses exit code in reason when stderr is empty", async () => {
		const exec = makeExec(() => Promise.resolve({ code: 2, stdout: "", stderr: "" }));
		const result = await renameWorkspace(exec, "w652f1910e89a56", "my session");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("2");
	});
});
