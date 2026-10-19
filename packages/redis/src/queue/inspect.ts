import type { RedisClient } from 'bun';
import type { z } from 'zod';
import { runScript } from '../scripts/run-script';
import type { RetryOptions } from './flow-types';
import type { queueKeys } from './keys';
import { COUNTS, PAUSE, RESUME } from './scripts/admin';
import type { JobState, JobView, QueueCounts, QueueDefinition } from './types';
import { STATES, toView } from './view';

type Keys = ReturnType<typeof queueKeys>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

/** The set each state lives in, and whether it is read newest first. */
function placeOf(keys: Keys, state: JobState) {
	switch (state) {
		case 'waiting':
			return { key: keys.ready, newestFirst: false };
		case 'delayed':
			return { key: keys.delayed, newestFirst: false };
		case 'active':
			return { key: keys.active, newestFirst: false };
		case 'completed':
			return { key: keys.completed, newestFirst: true };
		case 'failed':
			return { key: keys.failed, newestFirst: true };
	}
}

/** One job, or `undefined` when there is none. */
export async function getJob<
	S extends z.ZodType,
	R extends z.ZodType | undefined = undefined,
>(
	client: RedisClient,
	keys: Keys,
	definition: QueueDefinition<S, R>,
	id: string,
): Promise<JobView<S, R> | undefined> {
	const hash = (await client.hgetall(keys.job(id))) as Record<
		string,
		string
	> | null;
	return toView(definition, id, hash && Object.keys(hash).length ? hash : null);
}

/**
 * One page of a state, in its order. The ids come from one `ZRANGE`; the
 * hashes from one `HGETALL` each, all issued together so Bun pipelines them
 * into a single round trip. An id whose hash is gone (trimmed between the
 * two reads) is skipped, so a page may be shorter than `limit`.
 *
 * @throws TypeError for an `offset` that is not a whole number from 0, or a
 * `limit` that is not one from 1 to 1000.
 */
export async function listJobs<
	S extends z.ZodType,
	R extends z.ZodType | undefined = undefined,
>(
	client: RedisClient,
	keys: Keys,
	definition: QueueDefinition<S, R>,
	state: JobState,
	page: { offset?: number; limit?: number } | undefined,
): Promise<JobView<S, R>[]> {
	const offset = page?.offset ?? 0;
	const limit = page?.limit ?? DEFAULT_LIMIT;
	if (!Number.isInteger(offset) || offset < 0) {
		throw new TypeError(
			`list on "${definition.name}": offset is a whole number from 0`,
		);
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new TypeError(
			`list on "${definition.name}": limit is a whole number from 1 to ${MAX_LIMIT}`,
		);
	}
	if (!STATES.includes(state)) {
		throw new TypeError(
			`list on "${definition.name}": state is one of ${STATES.join(', ')}`,
		);
	}
	const { key, newestFirst } = placeOf(keys, state);
	const range = [key, String(offset), String(offset + limit - 1)];
	if (newestFirst) range.push('REV');
	const ids = (await client.send('ZRANGE', range)) as string[];
	const hashes = await Promise.all(
		ids.map((id) => client.hgetall(keys.job(id))),
	);
	const views: JobView<S, R>[] = [];
	ids.forEach((id, i) => {
		const hash = hashes[i] as Record<string, string> | null;
		const view = toView(
			definition,
			id,
			hash && Object.keys(hash).length ? hash : null,
		);
		if (view) views.push(view);
	});
	return views;
}

/** How many jobs are in each state: one script. */
export async function countJobs(
	client: RedisClient,
	keys: Keys,
): Promise<QueueCounts> {
	const reply = await runScript(
		client,
		COUNTS,
		[
			keys.delayed,
			keys.ready,
			keys.active,
			keys.completed,
			keys.failed,
			keys.paused,
		],
		[],
	);
	if (
		!Array.isArray(reply) ||
		reply.length !== 6 ||
		reply.some((n) => typeof n !== 'number')
	) {
		throw new Error('queue script reply not recognised: counts');
	}
	const [waiting, delayed, active, completed, failed, paused] =
		reply as number[];
	return {
		waiting: waiting as number,
		delayed: delayed as number,
		active: active as number,
		completed: completed as number,
		failed: failed as number,
		paused: paused === 1,
	};
}

/** Pauses the queue, for every worker of every process: one script. */
export async function pauseQueue(
	client: RedisClient,
	keys: Keys,
): Promise<void> {
	await runScript(client, PAUSE, [keys.paused], []);
}

/** Resumes the queue, waking a blocked worker when jobs wait: one script. */
export async function resumeQueue(
	client: RedisClient,
	keys: Keys,
	grouped = false,
): Promise<void> {
	await runScript(
		client,
		RESUME,
		[keys.paused, keys.ready, keys.wake, keys.delayed, keys.groupsReady],
		[grouped ? '1' : '0'],
	);
}

/**
 * Checks `retry`'s options as `resolveAdd` checks `add`'s: a bare `TypeError`
 * naming the call and the queue, never the value, and unknown keys ignored.
 */
export function resolveRetry(
	options: RetryOptions | undefined,
	queue: string,
): boolean {
	const { fresh } = (options ?? {}) as { fresh?: unknown };
	if (fresh !== undefined && typeof fresh !== 'boolean') {
		throw new TypeError(`retry on "${queue}": fresh is true or false`);
	}
	return fresh === true;
}
