const ACTIVE_STATUSES = new Set(["starting", "running", "recovering"]);
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed"]);

export class JobScheduler {
  constructor(options = {}) {
    const concurrency = Number(options.concurrency ?? 3);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("concurrency must be a positive integer");
    }
    if (typeof options.spawnJob !== "function") throw new Error("spawnJob is required");
    this.concurrency = concurrency;
    this.spawnJob = options.spawnJob;
    this.queued = [];
    this.active = new Map();
    this.terminal = [];
  }

  enqueue(job) {
    if (!job?.jobId) throw new Error("jobId is required");
    if (this.#contains(job.jobId)) return false;
    this.queued.push({ ...job, status: "queued" });
    this.#pump();
    return true;
  }

  restore(jobs) {
    for (const job of jobs) {
      if (this.#contains(job.jobId)) continue;
      if (ACTIVE_STATUSES.has(job.status)) this.active.set(job.jobId, { ...job });
      else if (TERMINAL_STATUSES.has(job.status)) this.terminal.push({ ...job });
      else this.queued.push({ ...job, status: "queued" });
    }
    this.#pump();
  }

  complete(jobId, terminalState = "completed") {
    if (!TERMINAL_STATUSES.has(terminalState)) throw new Error(`Invalid terminal state: ${terminalState}`);
    const job = this.active.get(jobId);
    if (!job) return false;
    this.active.delete(jobId);
    this.terminal.push({ ...job, status: terminalState });
    this.#pump();
    return true;
  }

  cancel(jobId) {
    const queuedIndex = this.queued.findIndex(job => job.jobId === jobId);
    if (queuedIndex >= 0) {
      const [job] = this.queued.splice(queuedIndex, 1);
      this.terminal.push({ ...job, status: "cancelled" });
      return "queued";
    }
    const active = this.active.get(jobId);
    if (active) {
      this.active.set(jobId, { ...active, cancelRequested: true });
      return "active";
    }
    return null;
  }

  snapshot() {
    return {
      concurrency: this.concurrency,
      queued: this.queued.map(job => ({ ...job })),
      active: [...this.active.values()].map(job => ({ ...job })),
      terminal: this.terminal.map(job => ({ ...job })),
    };
  }

  #contains(jobId) {
    return this.active.has(jobId)
      || this.queued.some(job => job.jobId === jobId)
      || this.terminal.some(job => job.jobId === jobId);
  }

  #threadIsActive(threadId) {
    if (!threadId) return false;
    return [...this.active.values()].some(job => job.threadId === threadId);
  }

  #pump() {
    while (this.active.size < this.concurrency) {
      const index = this.queued.findIndex(job => !this.#threadIsActive(job.threadId));
      if (index < 0) return;
      const [job] = this.queued.splice(index, 1);
      const activeJob = { ...job, status: "starting" };
      this.active.set(job.jobId, activeJob);
      try {
        this.spawnJob(activeJob);
      } catch (error) {
        this.active.delete(job.jobId);
        this.terminal.push({ ...activeJob, status: "failed", error: error?.message || String(error) });
      }
    }
  }
}
