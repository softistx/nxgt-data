import type { RedisClient } from 'bun';
import type { z } from 'zod';
import { runScript } from '../scripts/run-script';
import { checkQueue } from './define-queue';
import { encodeData, resolveAdd } from './encode';
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
export function bindQueue<S extends z.ZodType>(
	client: RedisClient,
	definition: QueueDefinition<S>,
): BoundQueue<S> {
	checkQueue(definition, 'bindQueue');
	const keys = queueKeys(definition.name);

	async function addMany(
		items: readonly { data: z.input<S>; options?: AddOptions }[],
	): Promise<JobHandle[]> {
		// Everything is checked and encoded before the first script runs, so a
		// bad item refuses the whole call with nothing written.
		const jobs = items.map((item) => {
			const call = 'addMany';
			const options = resolveAdd(item.options, call);
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
	): Promise<JobHandle[]> {
		const handles: JobHandle[] = [];
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
				);
			}
			const reply = (await runScript(
				client,
				ADD,
				[keys.delayed, keys.ready, keys.seq, keys.wake],
				argv,
			)) as number[];
			chunk.forEach(({ options }, i) => {
				handles.push({ id: options.id, deduplicated: reply[i] === 1 });
			});
		}
		return handles;
	}

	return {
		definition,
		async add(data, options) {
			const resolved = resolveAdd(options, 'add');
			const json = encodeData(definition, data, 'add');
			const [handle] = await send([{ options: resolved, data: json }]);
			if (!handle) throw new Error('add: the script answered nothing');
			return handle;
		},
		addMany,
		work(handler, options) {
			return startWorker(
				client,
				definition,
				keys,
				handler,
				resolveWork(options),
			);
		},
	};
}
