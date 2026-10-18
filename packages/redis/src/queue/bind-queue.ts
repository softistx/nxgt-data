import type { RedisClient } from 'bun';
import type { z } from 'zod';
import { runScript } from '../scripts/run-script';
import { checkQueue } from './define-queue';
import { encodeData, resolveAdd } from './encode';
import { countJobs, getJob, listJobs, removeJob, retryJob } from './inspect';
import { queueKeys } from './keys';
import { ADD } from './scripts/add';
import type {
	AddOptions,
	BoundQueue,
	JobHandle,
	QueueDefinition,
} from './types';
import { resolveWork, startWorker } from './worker/worker';

/** Jobs one `ADD` script call carries: a bound on its run time and its reply. */
const ADD_CHUNK = 500;

/**
 * Binds a queue to a client. It checks the definition again — one written by
 * hand, or changed after `defineQueue`, would otherwise fail deep in a script.
 */
export function bindQueue<
	S extends z.ZodType,
	R extends z.ZodType | undefined = undefined,
>(client: RedisClient, definition: QueueDefinition<S, R>): BoundQueue<S, R> {
	checkQueue<S, R>(definition, 'bindQueue');
	const keys = queueKeys(definition.name);

	async function addMany(
		items: readonly { data: z.input<S>; options?: AddOptions }[],
	): Promise<JobHandle<R>[]> {
		// Everything is checked and encoded before the first script runs, so a
		// bad item refuses the whole call with nothing written.
		const jobs = items.map((item) => {
			const call = 'addMany';
			const options = resolveAdd(item.options, call, definition.name);
			const data = encodeData(definition, item.data, call);
			return { options, data };
		});
		return await send(jobs);
	}

	async function send(
		jobs: readonly {
			options: ReturnType<typeof resolveAdd>;
			data: string;
		}[],
	): Promise<JobHandle<R>[]> {
		const handles: JobHandle<R>[] = [];
		for (let from = 0; from < jobs.length; from += ADD_CHUNK) {
			const chunk = jobs.slice(from, from + ADD_CHUNK);
			const argv: (string | number)[] = [keys.prefix];
			for (const { options, data } of chunk) {
				argv.push(
					options.id,
					data,
					options.priority,
					definition.attempts,
					options.delayMs,
					options.atMs,
					options.timeoutMs ?? -1,
				);
			}
			const reply = (await runScript(
				client,
				ADD,
				[keys.delayed, keys.ready, keys.seq, keys.wake],
				argv,
			)) as number[];
			chunk.forEach(({ options }, i) => {
				// Task 4 returns the full handle: `finished` and `cancel` are not there yet.
				handles.push({
					id: options.id,
					deduplicated: reply[i] === 1,
				} as JobHandle<R>);
			});
		}
		return handles;
	}

	return {
		definition,
		async add(data, options) {
			const resolved = resolveAdd(options, 'add', definition.name);
			const json = encodeData(definition, data, 'add');
			const [handle] = await send([{ options: resolved, data: json }]);
			if (!handle)
				throw new Error(
					`add on "${definition.name}": the script answered nothing`,
				);
			return handle;
		},
		addMany,
		get: (id) => getJob(client, keys, definition, id),
		list: (state, page) => listJobs(client, keys, definition, state, page),
		counts: () => countJobs(client, keys),
		retry: (id) => retryJob(client, keys, definition, id),
		remove: (id) => removeJob(client, keys, definition, id),
		// Task 4 implements it.
		cancel: () => Promise.reject(new Error('cancel is not implemented yet')),
		work(handler, options) {
			return startWorker(
				client,
				definition,
				keys,
				handler,
				resolveWork(options, definition.name),
			);
		},
	};
}
