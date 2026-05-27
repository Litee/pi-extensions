/**
 * Upstream source: https://github.com/tintinweb/pi-schedule-prompt
 * Original author: tintinweb. MIT licensed.
 * Copied from pi-schedule-prompt v0.3.0 for local experimentation.
 * Any upstream fixes should be pulled via a diff against the link above.
 */

import * as fs from "fs";
import * as path from "path";
import type { CronJob, CronStore } from "./types.js";

/** Allows explicitly setting optional CronJob fields to `undefined` (for clearing). */
type LenientPartial = { [K in keyof CronJob]?: CronJob[K] | undefined };

/**
 * Handles persistence of scheduled prompts to .pi/schedule-prompts.json
 */
export class CronStorage {
  private readonly storePath: string;
  private readonly piDir: string;

  constructor(cwd: string) {
    this.piDir = path.join(cwd, ".pi");
    this.storePath = path.join(this.piDir, "schedule-prompts.json");
  }

  /**
   * Load scheduled prompts from disk
   */
  load(): CronStore {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = fs.readFileSync(this.storePath, "utf-8");
        const store = JSON.parse(data) as CronStore;
        return store;
      }
    } catch {
      // ignore — fall through to empty store
    }

    // Return empty store if file doesn't exist or is corrupted
    return { jobs: [], version: 1 };
  }

  /**
   * Save scheduled prompts to disk
   */
  save(store: CronStore): void {
    try {
      // Ensure .pi directory exists
      if (!fs.existsSync(this.piDir)) {
        fs.mkdirSync(this.piDir, { recursive: true });
      }

      // Write atomically using temp file
      const tempPath = `${this.storePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), "utf-8");
      fs.renameSync(tempPath, this.storePath);
    } catch (error) {
      throw error;
    }
  }

  /**
   * Check if a job name already exists
   */
  hasJobWithName(name: string): boolean {
    const store = this.load();
    return store.jobs.some((j) => j.name === name);
  }

  /**
   * Add a new job
   */
  addJob(job: CronJob): void {
    const store = this.load();
    store.jobs.push(job);
    this.save(store);
  }

  /**
   * Remove a job by ID
   */
  removeJob(id: string): boolean {
    const store = this.load();
    const initialLength = store.jobs.length;
    store.jobs = store.jobs.filter((j) => j.id !== id);

    if (store.jobs.length < initialLength) {
      this.save(store);
      return true;
    }
    return false;
  }

  /**
   * Update a job by ID
   */
  updateJob(id: string, partial: LenientPartial): boolean {
    const store = this.load();
    const job = store.jobs.find((j) => j.id === id);

    if (job) {
      Object.assign(job, partial);
      this.save(store);
      return true;
    }
    return false;
  }

  /**
   * Get a single job by ID
   */
  getJob(id: string): CronJob | undefined {
    const store = this.load();
    return store.jobs.find((j) => j.id === id);
  }

  /**
   * Get all jobs
   */
  getAllJobs(): CronJob[] {
    const store = this.load();
    return store.jobs;
  }

  /**
   * Get storage file path
   */
  getStorePath(): string {
    return this.storePath;
  }
}

/**
 * In-memory CronStorage for use in tests — no disk I/O.
 * Extends CronStorage and overrides only load() and save(); every higher-level
 * method (addJob, removeJob, etc.) calls those two internally and works as-is.
 */
export class MemCronStorage extends CronStorage {
  private memStore: CronStore = { jobs: [], version: 1 };

  constructor() {
    super("/dev/null"); // cwd is irrelevant — disk is never touched
  }

  override load(): CronStore {
    // Return a deep-enough copy so callers can't mutate our internal store.
    return { ...this.memStore, jobs: this.memStore.jobs.map((j) => ({ ...j })) };
  }

  override save(store: CronStore): void {
    this.memStore = { ...store, jobs: store.jobs.map((j) => ({ ...j })) };
  }
}
