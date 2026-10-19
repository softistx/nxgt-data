import type { RedisClient } from 'bun';
import { runScript } from '../../scripts/run-script';
import { firstNext } from '../schedule/define';
import { SYNC } from '../scripts/schedule';
import type { WorkerContext } from './context';
import { emit } from './events';

type Syncing = Pick<
	WorkerContext,
	'client' | 'definition' | 'keys' | 'listeners'
>;

/** What one queue's SYNC has done on one client. */
type State = {
	/** True once it succeeded: never repeated. */
	done: boolean;
	/** The attempt in flight, shared by every worker of the queue. */
	attempt: Promise<void> | undefined;
	/** No new attempt before this ms. */
	retryAt: number;
	/** The wait after the next failure, doubling to the cap. */
	delay: number;
};

const FIRST_RETRY = 1_000;
const MAX_RETRY = 30_000;

/** The state of each queue's SYNC, by client. */
const synced = new WeakMap<RedisClient, Map<string, State>>();

async function sync(context: Syncing): Promise<void> {
	const { client, definition, keys } = context;
	// The client's clock: SYNC keeps a stored score when nothing changed, so a
	// skew only shifts a first occurrence.
	const now = Date.now();
	const reply = await runScript(
		client,
		SYNC,
		[keys.schedules, keys.schedulesDefinition],
		[
			keys.schedule,
			...definition.schedules.flatMap((s) => [
				s.id,
				s.kind,
				s.spec,
				s.timezone,
				s.data,
				firstNext(s, now),
			]),
		],
	);
	if (!Array.isArray(reply) || reply.length !== 2) {
		throw new Error('queue script reply not recognised: schedules sync');
	}
}

function stateOf(context: Syncing): State {
	let queues = synced.get(context.client);
	if (!queues) {
		queues = new Map();
		synced.set(context.client, queues);
	}
	const name = context.keys.schedules;
	let state = queues.get(name);
	if (!state) {
		state = {
			done: false,
			attempt: undefined,
			retryAt: 0,
			delay: FIRST_RETRY,
		};
		queues.set(name, state);
	}
	return state;
}

/**
 * Makes the stored definition schedules match the queue's, once per client and
 * queue in this process. Never rejects: a failure is an `error` event, and the
 * claims go on without it, so jobs keep running while the static schedules wait.
 * The next rounds try again, after 1 s doubling to 30 s, until one succeeds,
 * and a success is never repeated. While an attempt is in flight, every caller
 * waits for it, so the first claim of a healthy worker follows its SYNC.
 */
export function syncSchedules(context: Syncing): Promise<void> {
	const state = stateOf(context);
	if (state.done) return Promise.resolve();
	if (state.attempt) return state.attempt;
	if (Date.now() < state.retryAt) return Promise.resolve();
	state.attempt = sync(context).then(
		() => {
			state.done = true;
			state.attempt = undefined;
		},
		(error) => {
			state.retryAt = Date.now() + state.delay;
			state.delay = Math.min(state.delay * 2, MAX_RETRY);
			state.attempt = undefined;
			emit(context, 'error', error);
		},
	);
	return state.attempt;
}

/**
 * How long until a failed SYNC may be tried again, so an idle loop wakes for
 * it instead of sleeping to its cap; infinite once SYNC succeeded.
 */
export function syncRetryIn(context: Syncing): number {
	const state = stateOf(context);
	if (state.done) return Number.POSITIVE_INFINITY;
	return Math.max(0, state.retryAt - Date.now());
}
