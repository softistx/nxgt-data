/** What a queue refused. */
export type QueueErrorCode =
	/**
	 * A payload the queue refuses: one its schema rejects, or that does not
	 * survive JSON. A malformed *option* is a `TypeError`, not this.
	 */
	| 'INVALID'
	/** `retry` or `remove` named a job the queue does not hold in that state. */
	| 'NOT_FOUND'
	/** The job is running, so the call cannot change or remove it. */
	| 'ACTIVE'
	/** The job was canceled before it finished. */
	| 'CANCELED'
	/** The job failed for good; `lastError` says how. */
	| 'FAILED'
	/** `finished` waited as long as its `timeout` allowed. */
	| 'WAIT_TIMEOUT'
	/** A run took longer than its `timeout`. */
	| 'TIMEOUT'
	/** A run lost its lease to another worker. */
	| 'LEASE_LOST'
	/** The call came after the worker or the queue was closed. */
	| 'CLOSED';

/**
 * The error of the queue, apart from `RedisError`. Redis's own failures come
 * back as they are, from Bun's client; this is for what the queue decides.
 *
 * It names the **queue** and the job id, never the payload: a payload came
 * from a request, and a log line is no place for a user id or an address.
 */
export class QueueError extends Error {
	readonly code: QueueErrorCode;
	/** The queue's `name`. */
	readonly queue: string;
	/** The id of the job the call was about, when it was about one. */
	readonly job?: string;
	/** For `FAILED`: the name and message of the handler's last error. */
	readonly lastError?: { name: string; message: string };

	constructor(
		code: QueueErrorCode,
		queue: string,
		message: string,
		job?: string,
		lastError?: { name: string; message: string },
	) {
		super(message);
		this.name = 'QueueError';
		this.code = code;
		this.queue = queue;
		if (job !== undefined) {
			this.job = job;
		}
		if (lastError !== undefined) {
			this.lastError = lastError;
		}
	}
}
