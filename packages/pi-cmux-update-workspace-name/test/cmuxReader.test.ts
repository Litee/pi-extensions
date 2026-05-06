import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	__setCmuxReaderForTests,
	readWorkspaceTitle,
} from "../src/cmuxReader.js";

type StubReader = (args: string[]) => Promise<string>;

/**
 * Stub the read-side cmux spawner with a per-call dispatch table so tests can
 * assert on the argv that was issued and control the captured stdout.
 */
function stubReader(
	responses: Record<string, string | Error>,
): {
	calls: string[][];
	reader: StubReader;
} {
	const calls: string[][] = [];
	const reader: StubReader = async (args) => {
		calls.push(args);
		const key = args.join(" ");
		const resp = responses[key];
		if (resp === undefined) return "";
		if (resp instanceof Error) throw resp;
		return resp;
	};
	return { calls, reader };
}

beforeEach(() => {
	process.env["CMUX_WORKSPACE_ID"] = "w1";
});

afterEach(() => {
	__setCmuxReaderForTests(null);
	delete process.env["CMUX_WORKSPACE_ID"];
});

// ---------------------------------------------------------------------------
// readWorkspaceTitle — parses `workspace.title` out of `cmux rpc workspace.current`
// ---------------------------------------------------------------------------

describe("readWorkspaceTitle", () => {
	it("returns the title when the RPC produces a well-formed payload", async () => {
		const { calls, reader } = stubReader({
			"rpc workspace.current": JSON.stringify({
				workspace: { title: "Terminal 7" },
			}),
		});
		__setCmuxReaderForTests(reader);
		const got = await readWorkspaceTitle();
		expect(got).toBe("Terminal 7");
		expect(calls).toEqual([["rpc", "workspace.current"]]);
	});

	it("returns null when cmux is not available (no CMUX_WORKSPACE_ID)", async () => {
		delete process.env["CMUX_WORKSPACE_ID"];
		const { calls, reader } = stubReader({});
		__setCmuxReaderForTests(reader);
		expect(await readWorkspaceTitle()).toBeNull();
		expect(calls).toEqual([]);
	});

	it("returns null when the RPC payload is not valid JSON", async () => {
		const { reader } = stubReader({ "rpc workspace.current": "not json {" });
		__setCmuxReaderForTests(reader);
		expect(await readWorkspaceTitle()).toBeNull();
	});

	it("returns null when workspace.title is missing", async () => {
		const { reader } = stubReader({
			"rpc workspace.current": JSON.stringify({ workspace: {} }),
		});
		__setCmuxReaderForTests(reader);
		expect(await readWorkspaceTitle()).toBeNull();
	});

	it("returns null when the spawner throws (timeout / non-zero exit)", async () => {
		const { reader } = stubReader({
			"rpc workspace.current": new Error("boom"),
		});
		__setCmuxReaderForTests(reader);
		expect(await readWorkspaceTitle()).toBeNull();
	});

	it("treats an empty title string as null (no useful information)", async () => {
		const { reader } = stubReader({
			"rpc workspace.current": JSON.stringify({ workspace: { title: "" } }),
		});
		__setCmuxReaderForTests(reader);
		expect(await readWorkspaceTitle()).toBeNull();
	});
});
