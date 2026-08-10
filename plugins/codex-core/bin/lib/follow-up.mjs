import { sameProject } from "./project-scope.mjs";

/**
 * Decide how a follow-up turn should resume its session's Codex thread.
 *
 * Pure (no I/O) so it can be unit-tested deterministically. A Codex thread's
 * rollout persists on disk once ANY turn in the session has completed, so the
 * thread stays resumable even when the most recent turn was cancelled (e.g. via
 * /halt) or failed. Rather than gate resume on the newest job being `completed`
 * — which would strand a perfectly recoverable session — we resume the most
 * recent COMPLETED thread and inherit model/effort/project from the newest job.
 *
 * @param {Array<object>} sessionJobs Jobs for the session, sorted newest-first.
 * @param {object} request The incoming follow-up request.
 * @returns {{threadId: string, model: any, effort: any} | {error: {code: string, message: string}}}
 */
export function planFollowUp(sessionJobs, request) {
  const previous = sessionJobs[0];
  const resumable = sessionJobs.find(job => job.threadId && job.status === "completed");
  if (!previous || !resumable) {
    return {
      error: {
        code: "THREAD_NOT_READY",
        message: `No resumable v3 session to follow up: ${request.sessionId}`,
      },
    };
  }
  if (!sameProject(previous.projectRoot, request.projectRoot)) {
    return {
      error: {
        code: "PROJECT_MISMATCH",
        message: `Session project mismatch: ${previous.projectRoot} != ${request.projectRoot}`,
      },
    };
  }
  return {
    threadId: resumable.threadId,
    model: request.modelExplicit ? request.model : previous.model,
    effort: request.effortExplicit ? request.effort : previous.effort,
  };
}
