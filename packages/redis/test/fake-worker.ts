import type { Worker } from '../src/queue/worker/types';

/** What a {@link fake} worker does around its close. */
export type FakeOptions = {
	reject?: Error;
	/** Refuses a negative `grace` as the real close does: a rejection that is not memoised. */
	refuse?: Error;
	throws?: Error;
	hold?: Promise<void>;
	during?: () => Promise<void>;
};

/** A worker double whose close is memoised, as a real one's is: `closes` counts the first call's options and later calls. */
export function fake(options: FakeOptions = {}) {
	const closes: unknown[] = [];
	let first: Promise<void> | undefined;
	const worker = {
		close: (given?: unknown) => {
			closes.push(given);
			if (options.throws) throw options.throws;
			const grace = (given as { grace?: unknown } | undefined)?.grace;
			if (options.refuse && typeof grace === 'number' && grace < 0) {
				return Promise.reject(options.refuse);
			}
			first ??= (async () => {
				await options.during?.();
				await options.hold;
				if (options.reject) throw options.reject;
			})();
			return first;
		},
		on: () => () => undefined,
		idle: async () => undefined,
		[Symbol.asyncDispose]: async () => undefined,
	} as unknown as Worker;
	return { worker, closes };
}

/** A promise settled by hand. */
export function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
