import { describe, it, expect, vi } from "vitest";
import { seedMissingBaselines, type SeedableWatch } from "../src/seed-baselines.js";

function makeWatch(overrides: Partial<SeedableWatch> = {}): SeedableWatch & { id: number } {
	return {
		terminal: false,
		baseline: undefined,
		id: Math.random(),
		...overrides,
	};
}

describe("seedMissingBaselines", () => {
	it("skips terminal watches — does not call snapshot", async () => {
		const w = makeWatch({ terminal: true });
		const snapshot = vi.fn().mockResolvedValue({ exists: true });
		await seedMissingBaselines([w], { snapshot, onError: vi.fn() });
		expect(snapshot).not.toHaveBeenCalled();
		expect(w.baseline).toBeUndefined();
	});

	it("skips watches with an existing baseline", async () => {
		const existing = { exists: true };
		const w = makeWatch({ baseline: existing });
		const snapshot = vi.fn();
		await seedMissingBaselines([w], { snapshot, onError: vi.fn() });
		expect(snapshot).not.toHaveBeenCalled();
		expect(w.baseline).toBe(existing);
	});

	it("mutates watch.baseline in-place on success", async () => {
		const w = makeWatch();
		const fresh = { exists: true, etag: "abc" };
		const snapshot = vi.fn().mockResolvedValue(fresh);
		await seedMissingBaselines([w], { snapshot, onError: vi.fn() });
		expect(snapshot).toHaveBeenCalledOnce();
		expect(snapshot).toHaveBeenCalledWith(w);
		expect(w.baseline).toBe(fresh);
	});

	it("forwards snapshot errors to onError and leaves baseline undefined", async () => {
		const w = makeWatch();
		const boom = new Error("network fail");
		const snapshot = vi.fn().mockRejectedValue(boom);
		const onError = vi.fn();
		await seedMissingBaselines([w], { snapshot, onError });
		expect(onError).toHaveBeenCalledOnce();
		expect(onError).toHaveBeenCalledWith(w, boom);
		expect(w.baseline).toBeUndefined();
	});

	it("continues processing subsequent watches after one error", async () => {
		const w1 = makeWatch();
		const w2 = makeWatch();
		const boom = new Error("fail");
		const w2baseline = { exists: false };
		const snapshot = vi
			.fn()
			.mockRejectedValueOnce(boom)
			.mockResolvedValueOnce(w2baseline);
		const onError = vi.fn();
		await seedMissingBaselines([w1, w2], { snapshot, onError });
		expect(onError).toHaveBeenCalledOnce();
		expect(w1.baseline).toBeUndefined();
		expect(w2.baseline).toBe(w2baseline);
	});

	it("processes multiple watches in order", async () => {
		const watches = [makeWatch(), makeWatch(), makeWatch()];
		const order: number[] = [];
		const snapshot = vi.fn().mockImplementation((w: (typeof watches)[0]) => {
			order.push(w.id);
			return { exists: true };
		});
		await seedMissingBaselines(watches, { snapshot, onError: vi.fn() });
		expect(order).toEqual(watches.map((w) => w.id));
	});

	it("launches all snapshots concurrently — all calls start before any resolves", async () => {
		const resolvers: Array<() => void> = [];
		const startOrder: number[] = [];

		const watches = [makeWatch(), makeWatch(), makeWatch()];
		const snapshot = vi.fn().mockImplementation((w: (typeof watches)[0]) => {
			startOrder.push(w.id);
			return new Promise<{ exists: boolean }>((resolve) => {
				resolvers.push(() => resolve({ exists: true }));
			});
		});

		const done = seedMissingBaselines(watches, { snapshot, onError: vi.fn() });

		// All three snapshot calls must have been initiated before any resolved.
		expect(startOrder).toEqual(watches.map((w) => w.id));

		// Resolve all and await completion.
		resolvers.forEach((r) => r());
		await done;

		for (const w of watches) {
			expect(w.baseline).toEqual({ exists: true });
		}
	});
});
