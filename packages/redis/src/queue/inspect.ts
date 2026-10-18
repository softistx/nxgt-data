import type { RedisClient } from 'bun';
import type { z } from 'zod';
import { QueueError } from '../errors/queue-error';
import { runScript } from '../scripts/run-script';
import { decodeData } from './encode';
import type { queueKeys } from './keys';
import { COUNTS, REMOVE, RETRY } from './scripts/admin';
import { scriptKeys } from './scripts/claim';
import type { JobState, JobView, QueueCounts, QueueDefinition } from './types';

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

const STATES: readonly string[] = [
	'waiting',
	'delayed',
	'active',
	'completed',
	'failed',
];

function date(value: string | undefined): Date | undefined {
	if (value === undefined || !/^\d+$/.test(value)) return undefined;
	return new Date(Number(value));
}

/**
 * Maps a job hash to a {@link JobView}. A hash that is not one this package
 * wrote (no `state` it knows) is `undefined`, as an absent job is: showing
 * guessed fields would be the "repair" the scripts refuse to do.
 */
export function toView<S extends z.ZodType>(
	definition: QueueDefinition<S>,
	id: string,
	hash: Record<string, string> | null,
): JobView<S> | undefined {
	if (!hash) return undefined;
	const { state, data, attempt, attempts, priority } = hash;
	const { error: stored, finished: end } = hash;
	const added = date(hash['added']);
	const runAt = date(hash['runAt']);
	if (
		state === undefined ||
		!STATES.includes(state) ||
		added === undefined ||
		runAt === undefined
	) {
		return undefined;
	}
	const decoded = data === undefined ? undefined : decodeData(definition, data);
	const view: JobView<S> = {
		id,
		state: state as JobState,
		data: decoded?.ok ? decoded.data : undefined,
		attempt: Number(attempt),
		attempts: Number(attempts),
		priority: Number(priority),
		added,
		runAt,
	};
	if (stored !== undefined) {
		try {
			const error = JSON.parse(stored) as { name: string; message: string };
			view.error = { name: String(error.name), message: String(error.message) };
		} catch {
			// An error text this package could not have written is left out.
		}
	}
	const finished = date(end);
	if (finished) view.finished = finished;
	return view;
}

/** One job, or `undefined` when there is none. */
export async function getJob<S extends z.ZodType>(
	client: RedisClient,
	keys: Keys,
	definition: QueueDefinition<S>,
	id: string,
): Promise<JobView<S> | undefined> {
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
export async function listJobs<S extends z.ZodType>(
	client: RedisClient,
	keys: Keys,
	definition: QueueDefinition<S>,
	state: JobState,
	page: { offset?: number; limit?: number } | undefined,
): Promise<JobView<S>[]> {
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
	const views: JobView<S>[] = [];
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
		[keys.delayed, keys.ready, keys.active, keys.completed, keys.failed],
		[],
	);
	if (
		!Array.isArray(reply) ||
		reply.length !== 5 ||
		reply.some((n) => typeof n !== 'number')
	) {
		throw new Error('queue script reply not recognised: counts');
	}
	const [waiting, delayed, active, completed, failed] = reply as number[];
	return {
		waiting: waiting as number,
		delayed: delayed as number,
		active: active as number,
		completed: completed as number,
		failed: failed as number,
	};
}

/**
 * Puts a failed job back to `waiting`, its attempts reset.
 *
 * @throws QueueError `NOT_FOUND` when the job is not in `failed`.
 */
export async function retryJob(
	client: RedisClient,
	keys: Keys,
	definition: { name: string },
	id: string,
): Promise<void> {
	const reply = await runScript(client, RETRY, scriptKeys(keys), [
		keys.prefix,
		id,
	]);
	if (reply !== 1) {
		throw new QueueError(
			'NOT_FOUND',
			definition.name,
			`retry on "${definition.name}": job "${id}" is not failed`,
			id,
		);
	}
}

/**
 * Removes a job that is not running.
 *
 * @throws QueueError `ACTIVE` for a running job, `NOT_FOUND` for none.
 */
export async function removeJob(
	client: RedisClient,
	keys: Keys,
	definition: { name: string },
	id: string,
): Promise<void> {
	const reply = await runScript(
		client,
		REMOVE,
		[keys.delayed, keys.ready, keys.active, keys.completed, keys.failed],
		[keys.prefix, id],
	);
	if (reply === 2) {
		throw new QueueError(
			'ACTIVE',
			definition.name,
			`remove on "${definition.name}": job "${id}" is running`,
			id,
		);
	}
	if (reply !== 1) {
		throw new QueueError(
			'NOT_FOUND',
			definition.name,
			`remove on "${definition.name}": no job "${id}"`,
			id,
		);
	}
}
