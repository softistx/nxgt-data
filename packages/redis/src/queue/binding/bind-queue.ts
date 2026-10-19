import type { RedisClient } from 'bun';
import type { z } from 'zod';
import { runScript } from '../../scripts/run-script';
import { checkQueue } from '../definition/define-queue';
import {
	countJobs,
	getJob,
	listJobs,
	pauseQueue,
	resolveRetry,
	resumeQueue,
} from '../inspect/inspect';
import { removeJob, retryJob } from '../inspect/job-admin';
import { scheduleHandle } from '../schedule/handle';
import { ADD } from '../scripts/add';
import { cancel } from '../scripts/cancel';
import { groupArgs } from '../scripts/claim/claim';
import { parseAddReply } from '../scripts/claim/replies';
import { guardMode } from '../scripts/groups/groups-mode';
import type { JobHandle } from '../types/handle-types';
import type { AddOptions, BoundQueue, QueueDefinition } from '../types/types';
import { resolveWork, startWorker } from '../worker/worker';
import { encodeData, resolveAdd } from './encode';
import { jobHandle } from './handle';
import { queueKeys } from './keys';
import { type QueueLife, refuseClosed, trackWorker } from './life';

/** Jobs one `ADD` script call carries: a bound on its run time and its reply. */
const ADD_CHUNK = 500;

/** A job checked and encoded, ready for `ADD`. */
type Encoded = { options: ReturnType<typeof resolveAdd>; data: string };

/**
 * Sends encoded jobs, one `ADD` per {@link ADD_CHUNK}, and answers their
 * handles in the order given.
 */
async function addChunks<S extends z.ZodType, R extends z.ZodType | undefined>(
	client: RedisClient,
	definition: QueueDefinition<S, R>,
	keys: ReturnType<typeof queueKeys>,
	jobs: readonly Encoded[],
	life: QueueLife | undefined,
	call: 'add' | 'addMany',
): Promise<JobHandle<R>[]> {
	const handles: JobHandle<R>[] = [];
	for (let from = 0; from < jobs.length; from += ADD_CHUNK) {
		// Between chunks too: a batch stops cleanly with CLOSED.
		refuseClosed(life, call, definition.name);
		const chunk = jobs.slice(from, from + ADD_CHUNK);
		const argv: (string | number)[] = [
			keys.prefix,
			keys.dedupe,
			...groupArgs(keys, definition.groups),
		];
		for (const { options, data } of chunk) {
			argv.push(
				options.id,
				data,
				options.priority,
				definition.attempts,
				options.delayMs,
				options.atMs,
				options.timeoutMs ?? -1,
				options.dedupe.mode,
				options.dedupe.key,
				options.dedupe.ttlMs,
				options.group,
			);
		}
		const reply = parseAddReply(
			await guardMode(
				client,
				keys,
				definition.groups,
				call,
				definition.name,
				() =>
					runScript(
						client,
						ADD,
						[
							keys.delayed,
							keys.ready,
							keys.seq,
							keys.wake,
							keys.paused,
							keys.groupsReady,
							keys.groupsQueued,
							keys.groupsMode,
						],
						argv,
					),
			),
			chunk.length,
		);
		chunk.forEach(({ options }, i) => {
			const answer = reply[i];
			handles.push(
				jobHandle(
					client,
					definition,
					keys,
					answer?.held ?? options.id,
					answer?.deduplicated ?? false,
					undefined,
					life,
				),
			);
		});
	}
	return handles;
}

/**
 * `addMany`: everything is checked and encoded before the first script runs,
 * so a bad item refuses the whole call with nothing written.
 */
async function addManyJobs<
	S extends z.ZodType,
	R extends z.ZodType | undefined,
>(
	client: RedisClient,
	definition: QueueDefinition<S, R>,
	keys: ReturnType<typeof queueKeys>,
	items: readonly { data: z.input<S>; options?: AddOptions }[],
	life: QueueLife | undefined,
): Promise<JobHandle<R>[]> {
	refuseClosed(life, 'addMany', definition.name);
	const call = 'addMany';
	const grouped = definition.groups !== undefined;
	const jobs = items.map((item) => ({
		options: resolveAdd(item.options, call, definition.name, grouped),
		data: encodeData(definition, item.data, call),
	}));
	return await addChunks(client, definition, keys, jobs, life, call);
}

/**
 * What wiring adds to a bound queue. Internal: a queue bound by hand has
 * neither. `life` is the Redis's close protocol: once it ends, `add`, `addMany`,
 * `finished` and `work` refuse with `CLOSED`.
 */
export type QueueWiring = {
	/** The deployment's prefix, kept apart from the name: `undefined` by hand. */
	readonly prefix: string | undefined;
	readonly life?: QueueLife | undefined;
};

/**
 * Binds a queue to a client. It checks the definition again — one written by
 * hand, or changed after `defineQueue`, would otherwise fail deep in a script.
 */
export function bindQueue<
	S extends z.ZodType,
	R extends z.ZodType | undefined = undefined,
>(client: RedisClient, definition: QueueDefinition<S, R>): BoundQueue<S, R> {
	return bindQueueWith(client, definition, {
		prefix: undefined,
		life: undefined,
	});
}

/**
 * Binds a queue under a wiring's prefix. The prefix stays a part of its own:
 * the definition is never renamed, and the storage name — the hash tag of the
 * keys — is `<prefix>:<name>`, or the name alone without a prefix.
 */
export function bindQueueWith<
	S extends z.ZodType,
	R extends z.ZodType | undefined = undefined,
>(
	client: RedisClient,
	definition: QueueDefinition<S, R>,
	wiring: QueueWiring,
): BoundQueue<S, R> {
	checkQueue<S, R>(definition, 'bindQueue');
	const { prefix, life } = wiring;
	const keys = queueKeys(
		prefix === undefined ? definition.name : `${prefix}:${definition.name}`,
	);

	const grouped = definition.groups !== undefined;

	return {
		definition,
		prefix,
		async add(data, options) {
			refuseClosed(life, 'add', definition.name);
			const resolved = resolveAdd(options, 'add', definition.name, grouped);
			const json = encodeData(definition, data, 'add');
			const [handle] = await addChunks(
				client,
				definition,
				keys,
				[{ options: resolved, data: json }],
				life,
				'add',
			);
			if (!handle)
				throw new Error(
					`add on "${definition.name}": the script answered nothing`,
				);
			return handle;
		},
		addMany: (items) => addManyJobs(client, definition, keys, items, life),
		get: (id) => getJob(client, keys, definition, id),
		list: (state, page) => listJobs(client, keys, definition, state, page),
		counts: () => countJobs(client, keys),
		pause: () => pauseQueue(client, keys),
		resume: () => resumeQueue(client, keys, grouped),
		async retry(id, options) {
			return await retryJob(
				client,
				keys,
				definition,
				id,
				resolveRetry(options, definition.name),
			);
		},
		remove: (id) => removeJob(client, keys, definition, id),
		cancel: (id) =>
			cancel(client, keys, id, definition.groups, definition.name),
		schedules: scheduleHandle(client, keys, definition),
		work(handler, options) {
			refuseClosed(life, 'work', definition.name);
			const worker = startWorker(client, definition, keys, handler, {
				...resolveWork(options, definition.name),
				prefix,
			});
			return life ? trackWorker(life, worker) : worker;
		},
	};
}
