/**
 * The processing queue broker failed or did not answer in time, so the job
 * may not have been enqueued. Callers must not assume the job exists.
 */
export class QueueUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
