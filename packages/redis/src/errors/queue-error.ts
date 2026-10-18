/** What a queue refused. */
export type QueueErrorCode =
	/**
	 * A payload the queue refuses: one its schema rejects (or throws on), or
	 * that does not survive JSON; also, from `finished`, a stored result the
	 * result schema refuses. A malformed *option* is a `TypeError`, not this.
	 */
	| 'INVALID'
	/**
	 * `retry` or `remove` named a job the queue does not hold in that state,
	 * or `finished` waited on a job that is not in the queue.
	 */
	| 'NOT_FOUND'
	/** The job is running, so the call cannot change or remove it. */
	| 'ACTIVE'
	/**
	 * The job was canceled before it finished: `finished`'s rejection, and
	 * the `signal.reason` of a run the cancel aborted. Never a call-time error.
	 */
	| 'CANCELED'
	/** The job failed for good; `lastError` says how. */
	| 'FAILED'
	/** `finished` waited as long as its `timeout` allowed. */
	| 'WAIT_TIMEOUT'
	/** A run took longer than its `timeout`: a `signal.reason`. */
	| 'TIMEOUT'
	/**
	 * A run lost its lease: another worker took the job back, or the job was
	 * canceled and the worker missed the event, so its renewal found the
	 * token gone. A `signal.reason`, reported on the worker's `error` event.
	 */
	| 'LEASE_LOST'
	/**
	 * The Redis of a wired queue is closed: `add`, `addMany` and `finished`
	 * reject with it once it is closed, and `work` throws it from the moment
	 * `close` was called; a `finished` still waiting rejects with it too. Also
	 * a run's `signal.reason` when its worker's `grace` passed while it went on.
	 */
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
	/**
	 * The id of the job the call was about, when it was about one. `declare`d,
	 * so an error about no job has no own `job` key at all.
	 */
	declare readonly job?: string;
	/** For `FAILED`: the name and message of the handler's last error; `declare`d like `job`. */
	declare readonly lastError?: { name: string; message: string };

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
