/** What a queue refused. */
export type QueueErrorCode =
	/**
	 * An argument the queue refuses: a payload its schema rejects, or an
	 * option that is out of range.
	 */
	| 'INVALID'
	/** `retry` or `remove` named a job the queue does not hold in that state. */
	| 'NOT_FOUND'
	/** The job is running, so the call cannot change or remove it. */
	| 'ACTIVE';

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

	constructor(
		code: QueueErrorCode,
		queue: string,
		message: string,
		job?: string,
	) {
		super(message);
		this.name = 'QueueError';
		this.code = code;
		this.queue = queue;
		if (job !== undefined) {
			this.job = job;
		}
	}
}
