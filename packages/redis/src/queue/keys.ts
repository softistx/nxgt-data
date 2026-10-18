/**
 * The keys of one queue. The name sits in braces — a Redis Cluster hash tag —
 * so every key lands on one slot and a script may touch them all.
 */
export function queueKeys(name: string) {
	const base = `queue:{${name}}:`;
	return {
		/** The hash of one job. */
		job: (id: string) => `${base}job:${id}`,
		/**
		 * What a script appends an id to, to reach a job it was not given as a
		 * key. Scripts build job keys, so they may only do so inside the slot.
		 */
		prefix: `${base}job:`,
		delayed: `${base}delayed`,
		ready: `${base}ready`,
		active: `${base}active`,
		completed: `${base}completed`,
		failed: `${base}failed`,
		/** The counter that keeps jobs of one priority in the order they came. */
		seq: `${base}seq`,
		/** The list an idle worker blocks on until work arrives. */
		wake: `${base}wake`,
		/** The pub/sub channel the final outcomes of jobs are published on. */
		events: `${base}events`,
	};
}
