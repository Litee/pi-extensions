import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export interface ExtPackageEntry {
	/** Display name: package.json#name for local paths, spec for npm/git */
	name: string;
	/** Raw string from settings.json (may start with _ for disabled entries) */
	raw: string;
	/** Path or spec with leading _ stripped */
	spec: string;
	scope: "project" | "user";
	kind: "local" | "npm" | "other";
	health: "ok" | "missing" | "unverified";
	/** True when the raw entry starts with _ (explicitly disabled by user) */
	disabled: boolean;
	/** True when the same package name appears in both user and project scope */
	conflict: boolean;
}

export interface SummaryStats {
	ok: number;
	missing: number;
	unverified: number;
	conflict: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testability)
// ---------------------------------------------------------------------------

export function detectKind(spec: string): "local" | "npm" | "other" {
	if (spec.startsWith("npm:")) return "npm";
	if (
		spec.startsWith("/") ||
		spec.startsWith("./") ||
		spec.startsWith("../") ||
		spec.startsWith("~/") ||
		spec.startsWith("~\\") ||
		/^[a-zA-Z]:[\\/]/.test(spec)
	)
		return "local";
	return "other";
}

export function resolveHome(spec: string, cwd = process.cwd()): string {
	if (spec.startsWith("~/") || spec.startsWith("~\\")) {
		return join(homedir(), spec.slice(2));
	}
	if (spec.startsWith("./") || spec.startsWith("../")) {
		return resolve(cwd, spec);
	}
	return spec;
}

export function checkHealth(spec: string, kind: "local" | "npm" | "other", cwd?: string): "ok" | "missing" | "unverified" {
	if (kind === "local") {
		return existsSync(resolveHome(spec, cwd)) ? "ok" : "missing";
	}
	return "unverified";
}

export function readPackageName(dir: string): string | undefined {
	try {
		const pkgPath = join(dir, "package.json");
		if (!existsSync(pkgPath)) return undefined;
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
		return typeof pkg.name === "string" ? pkg.name : undefined;
	} catch {
		return undefined;
	}
}

export function deriveName(
	spec: string,
	kind: "local" | "npm" | "other",
	health: "ok" | "missing" | "unverified",
	cwd?: string,
): string {
	if (kind === "npm") {
		const bare = spec.replace(/^npm:/, "");
		const atIdx = bare.startsWith("@") ? bare.indexOf("@", 1) : bare.indexOf("@");
		return atIdx > 0 ? bare.slice(0, atIdx) : bare;
	}
	if (kind === "local") {
		if (health === "missing") return spec.split("/").at(-1) ?? spec;
		return readPackageName(resolveHome(spec, cwd)) ?? spec.split("/").at(-1) ?? spec;
	}
	return spec;
}

function readPackageList(settingsPath: string): string[] {
	try {
		if (!existsSync(settingsPath)) return [];
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			packages?: unknown[];
			extensions?: unknown[];
		};
		const raw: string[] = [];
		for (const entry of settings.packages ?? []) {
			if (typeof entry === "string") {
				raw.push(entry);
			} else if (entry && typeof entry === "object" && "source" in entry && typeof entry.source === "string") {
				raw.push(entry.source);
			}
		}
		for (const entry of settings.extensions ?? []) {
			if (typeof entry === "string") raw.push(entry);
		}
		return raw;
	} catch {
		return [];
	}
}

export function buildSummary(entries: ExtPackageEntry[]): SummaryStats {
	return {
		ok: entries.filter((e) => e.health === "ok").length,
		missing: entries.filter((e) => e.health === "missing").length,
		unverified: entries.filter((e) => e.health === "unverified").length,
		conflict: entries.filter((e) => e.conflict).length,
	};
}

/**
 * Returns true when `spec` refers to a local path that does not exist on disk.
 * Strips a leading `_` (disabled-entry marker) before resolving.
 */
export function isLocalPathMissing(spec: string, cwd?: string): boolean {
	const clean = spec.startsWith("_") ? spec.slice(1) : spec;
	if (detectKind(clean) !== "local") return false;
	return !existsSync(resolveHome(clean, cwd));
}

export function markConflicts(entries: ExtPackageEntry[]): ExtPackageEntry[] {
	// A conflict is the same name present in both user and project scope.
	const scopes = new Map<string, Set<string>>();
	for (const e of entries) {
		if (!scopes.has(e.name)) scopes.set(e.name, new Set());
		scopes.get(e.name)!.add(e.scope);
	}
	return entries.map((e) => ({
		...e,
		conflict: (scopes.get(e.name)?.size ?? 0) > 1,
	}));
}

export function loadEntries(cwd: string): ExtPackageEntry[] {
	const agentDir = join(homedir(), ".pi", "agent");
	const sources: [string, "user" | "project"][] = [
		[join(agentDir, "settings.json"), "user"],
		[join(cwd, ".pi", "settings.json"), "project"],
	];

	const entries: ExtPackageEntry[] = [];
	for (const [settingsPath, scope] of sources) {
		const settingsDir = dirname(settingsPath);
		for (const raw of readPackageList(settingsPath)) {
			const disabled = raw.startsWith("_");
			const cleanSpec = disabled ? raw.slice(1) : raw;
			const spec = raw; // keep underscore for display
			const kind = detectKind(cleanSpec);
			const health = checkHealth(cleanSpec, kind, settingsDir);
			const name = deriveName(cleanSpec, kind, health, settingsDir);
			entries.push({ name, raw, spec, scope, kind, health, disabled, conflict: false });
		}
	}
	return markConflicts(entries);
}

export function filterEntries(entries: ExtPackageEntry[], query: string): ExtPackageEntry[] {
	if (!query) return entries;
	const q = query.toLowerCase();
	return entries.filter(
		(e) => e.name.toLowerCase().includes(q) || e.spec.toLowerCase().includes(q),
	);
}
