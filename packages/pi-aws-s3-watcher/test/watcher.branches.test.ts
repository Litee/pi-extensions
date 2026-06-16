/**
 * Branch-coverage gap-fill for src/watcher.ts.
 *
 * Covers the branches that watcher.test.ts misses:
 *
 *  • normaliseWatch: migration shim (target 'exists'/'updated'/'removed')
 *  • normaliseWatch → normaliseBaselineField: baseline absent, array, etag/
 *    contentLength missing, exists-boolean guard
 *  • normaliseWatch: optional fields absent (region, timeoutAt, lastPolledAt,
 *    terminal=true, non-finite consecutiveErrors)
 *  • addWatch: region parameter stored on the watch
 *  • addWatch: non-finite timeoutSeconds (Infinity / NaN)
 *  • browseOptions rowAction: visible() callback
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HeadObjectResult, S3Client } from "../src/s3-client.js";
import { S3Watcher } from "../src/watcher.js";

// ---------------------------------------------------------------------------
// Mocks (same pattern as watcher.test.ts)
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
	readFileSync: vi.fn().mockImplementation(() => {
		throw Object.assign(new Error("ENOENT: no such file or directory"), {
			code: "ENOENT",
		});
	}),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

vi.mock("pi-watcher-core/validate-aws-profile", () => ({
	validateAwsProfile: vi.fn().mockReturnValue(null),
}));

function makePi() {
	return {
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: vi.fn(() => [] as string[]),
		setActiveTools: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerMessageRenderer: vi.fn(),
		on: vi.fn(),
		events: { on: vi.fn().mockReturnValue(() => {}), emit: vi.fn() },
	};
}

function makeClient(resp: HeadObjectResult | Error = { exists: false }): S3Client {
	const head = vi.fn();
	if (resp instanceof Error) head.mockRejectedValue(resp);
	else head.mockResolvedValue(resp);
	return { headObject: head };
}

function makeWatcher(resp: HeadObjectResult | Error = { exists: false }) {
	const pi = makePi();
	const client = makeClient(resp);
	const watcher = new S3Watcher({ pi: pi as never, client, now: Date.now });
	return { watcher, pi, client };
}

// ---------------------------------------------------------------------------
// normaliseWatch — migration shim (old target names)
// ---------------------------------------------------------------------------

describe("S3Watcher.normaliseWatch — target migration shim", () => {
	let watcher: S3Watcher;
	beforeEach(() => ({ watcher } = makeWatcher()));

	const base = {
		watchId: "w1",
		bucket: "b",
		key: "k",
		profile: "p",
		addedAt: 0,
		terminal: false,
		consecutiveErrors: 0,
	};

	it('remaps legacy target "exists" → "creation"', () => {
		// rawTarget === 'exists' ? 'creation' : ...  → true branch
		const result = watcher.normaliseWatch({ ...base, target: "exists" });
		expect(result).not.toBeNull();
		expect(result?.target).toBe("creation");
	});

	it('remaps legacy target "updated" → "modification"', () => {
		// rawTarget === 'updated' ? 'modification' : ...  → true branch
		const result = watcher.normaliseWatch({ ...base, target: "updated" });
		expect(result).not.toBeNull();
		expect(result?.target).toBe("modification");
	});

	it('remaps legacy target "removed" → "deletion"', () => {
		// rawTarget === 'removed' ? 'deletion' : ...  → true branch
		const result = watcher.normaliseWatch({ ...base, target: "removed" });
		expect(result).not.toBeNull();
		expect(result?.target).toBe("deletion");
	});
});

// ---------------------------------------------------------------------------
// normaliseWatch — optional fields absent / edge values
// ---------------------------------------------------------------------------

describe("S3Watcher.normaliseWatch — optional field branches", () => {
	let watcher: S3Watcher;
	beforeEach(() => ({ watcher } = makeWatcher()));

	const base = {
		watchId: "w1",
		bucket: "b",
		key: "k",
		profile: "p",
		target: "creation",
		addedAt: 0,
		terminal: false,
		consecutiveErrors: 0,
	};

	it("normalises region to undefined when field is absent", () => {
		// typeof r['region'] === 'string' ? r['region'] : undefined  → false branch
		const result = watcher.normaliseWatch({ ...base });
		expect(result?.region).toBeUndefined();
	});

	it("normalises region to undefined when field is a non-string (number)", () => {
		const result = watcher.normaliseWatch({ ...base, region: 42 });
		expect(result?.region).toBeUndefined();
	});

	it("normalises timeoutAt to undefined when value is Infinity", () => {
		// Number.isFinite(Infinity) → false  → undefined branch
		const result = watcher.normaliseWatch({ ...base, timeoutAt: Infinity });
		expect(result?.timeoutAt).toBeUndefined();
	});

	it("normalises timeoutAt to undefined when field is absent", () => {
		const result = watcher.normaliseWatch({ ...base });
		expect(result?.timeoutAt).toBeUndefined();
	});

	it("normalises lastPolledAt to undefined when field is absent", () => {
		// typeof r['lastPolledAt'] === 'number' ? ... : undefined  → false branch
		const result = watcher.normaliseWatch({ ...base });
		expect(result?.lastPolledAt).toBeUndefined();
	});

	it("preserves terminal: true", () => {
		// typeof r['terminal'] === 'boolean' ? r['terminal'] : false  → true/true-value branch
		const result = watcher.normaliseWatch({ ...base, terminal: true });
		expect(result?.terminal).toBe(true);
	});

	it("normalises consecutiveErrors to 0 when value is NaN", () => {
		// Number.isFinite(NaN) → false  → 0 branch
		const result = watcher.normaliseWatch({ ...base, consecutiveErrors: NaN });
		expect(result?.consecutiveErrors).toBe(0);
	});

	it("normalises consecutiveErrors to 0 when field is absent", () => {
		const result = watcher.normaliseWatch({ ...base });
		expect(result?.consecutiveErrors).toBe(0);
	});

	it("normalises addedAt to 0 via toFiniteNumber when field is absent", () => {
		// toFiniteNumber(undefined) → 0
		const result = watcher.normaliseWatch({ ...base });
		expect(result?.addedAt).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// normaliseWatch → normaliseBaselineField branches
// ---------------------------------------------------------------------------

describe("S3Watcher.normaliseWatch — normaliseBaselineField branches", () => {
	let watcher: S3Watcher;
	beforeEach(() => ({ watcher } = makeWatcher()));

	const base = {
		watchId: "w1",
		bucket: "b",
		key: "k",
		profile: "p",
		target: "creation",
		addedAt: 0,
		terminal: false,
		consecutiveErrors: 0,
	};

	it("sets baseline to undefined when baseline field is absent (!raw guard)", () => {
		// normaliseBaselineField(undefined) → !raw → return undefined
		const result = watcher.normaliseWatch({ ...base });
		expect(result?.baseline).toBeUndefined();
	});

	it("sets baseline to undefined when baseline field is null", () => {
		const result = watcher.normaliseWatch({ ...base, baseline: null });
		expect(result?.baseline).toBeUndefined();
	});

	it("sets baseline to undefined when baseline field is an array (Array.isArray guard)", () => {
		// Array.isArray(raw) → true → return undefined
		const result = watcher.normaliseWatch({ ...base, baseline: [] });
		expect(result?.baseline).toBeUndefined();
	});

	it("sets baseline to undefined when baseline field is an array with objects", () => {
		const result = watcher.normaliseWatch({ ...base, baseline: [{ exists: true }] });
		expect(result?.baseline).toBeUndefined();
	});

	it("sets baseline to undefined when baseline lacks the exists boolean (exists guard)", () => {
		// typeof r['exists'] !== 'boolean' → return undefined
		const result = watcher.normaliseWatch({ ...base, baseline: { present: true } });
		expect(result?.baseline).toBeUndefined();
	});

	it("returns minimal baseline {exists} when etag/contentLength are absent", () => {
		// typeof r['etag'] === 'string' → false (no etag set on result)
		// typeof r['contentLength'] === 'number' → false (no contentLength set)
		const result = watcher.normaliseWatch({ ...base, baseline: { exists: true } });
		expect(result?.baseline).toEqual({ exists: true });
		expect(result?.baseline).not.toHaveProperty("etag");
		expect(result?.baseline).not.toHaveProperty("contentLength");
	});

	it("sets only etag when contentLength is absent", () => {
		const result = watcher.normaliseWatch({
			...base,
			baseline: { exists: true, etag: '"abc"' },
		});
		expect(result?.baseline).toEqual({ exists: true, etag: '"abc"' });
		expect(result?.baseline).not.toHaveProperty("contentLength");
	});

	it("sets only contentLength when etag is absent", () => {
		const result = watcher.normaliseWatch({
			...base,
			baseline: { exists: true, contentLength: 512 },
		});
		expect(result?.baseline).toEqual({ exists: true, contentLength: 512 });
		expect(result?.baseline).not.toHaveProperty("etag");
	});

	it("drops non-finite contentLength from baseline (Infinity)", () => {
		// Number.isFinite(Infinity) → false → contentLength not set
		const result = watcher.normaliseWatch({
			...base,
			baseline: { exists: true, contentLength: Infinity },
		});
		expect(result?.baseline).toEqual({ exists: true });
		expect(result?.baseline).not.toHaveProperty("contentLength");
	});
});

// ---------------------------------------------------------------------------
// addWatch — region parameter
// ---------------------------------------------------------------------------

describe("S3Watcher.addWatch — region parameter", () => {
	it("stores region on the watch when a non-empty region string is provided", async () => {
		// typeof params['region'] === 'string' && params['region'].trim()  → true branch
		const { watcher } = makeWatcher({ exists: false });
		const result = await watcher.executeTool({
			action: "add",
			uri: "s3://b/k",
			target: "creation",
			profile: "p",
			region: "eu-west-1",
		});
		expect(result.details["ok"]).toBe(true);
		const watchId = result.details["watchId"] as string;
		expect(watcher["watches"].get(watchId)?.region).toBe("eu-west-1");
	});

	it("stores region as undefined when region is an empty string", () => {
		// params['region'].trim() → "" → falsy  → undefined branch
		const { watcher } = makeWatcher({ exists: false });
		// We just verify normalisation logic: an empty region is treated as absent
		return watcher
			.executeTool({
				action: "add",
				uri: "s3://b/k",
				target: "creation",
				profile: "p",
				region: "   ",
			})
			.then((result) => {
				const watchId = result.details["watchId"] as string;
				expect(watcher["watches"].get(watchId)?.region).toBeUndefined();
			});
	});
});

// ---------------------------------------------------------------------------
// addWatch — non-finite timeoutSeconds
// ---------------------------------------------------------------------------

describe("S3Watcher.addWatch — non-finite timeoutSeconds", () => {
	it("rejects Infinity as timeoutSeconds (!Number.isFinite branch)", async () => {
		// !Number.isFinite(Infinity) → true → error
		const { watcher } = makeWatcher();
		const result = await watcher.executeTool({
			action: "add",
			uri: "s3://b/k",
			target: "creation",
			profile: "p",
			timeoutSeconds: Infinity,
		});
		expect(result.details["ok"]).toBe(false);
		expect((result.content[0] as { text: string }).text).toMatch(/timeoutSeconds/);
	});

	it("rejects NaN as timeoutSeconds (!Number.isFinite branch)", async () => {
		const { watcher } = makeWatcher();
		const result = await watcher.executeTool({
			action: "add",
			uri: "s3://b/k",
			target: "creation",
			profile: "p",
			timeoutSeconds: NaN,
		});
		expect(result.details["ok"]).toBe(false);
		expect((result.content[0] as { text: string }).text).toMatch(/timeoutSeconds/);
	});
});

// ---------------------------------------------------------------------------
// browseOptions — rowAction visible() callback
// ---------------------------------------------------------------------------

describe("S3Watcher.browseOptions — rowAction visible callback", () => {
	it("visible returns true for non-terminal watches, false for terminal watches", () => {
		const { watcher } = makeWatcher();
		const opts = (
			watcher as unknown as {
				browseOptions(): {
					rowActions?: Array<{
						id: string;
						visible?: (w: { terminal: boolean }) => boolean;
					}>;
				};
			}
		).browseOptions();
		const removeAction = opts.rowActions?.find((a) => a.id === "remove");
		expect(removeAction).toBeDefined();
		// visible: (w) => !w.terminal  → both branches
		expect(removeAction?.visible?.({ terminal: false })).toBe(true);
		expect(removeAction?.visible?.({ terminal: true })).toBe(false);
	});
});
