import type { RedisClient } from 'bun';
import { runScript } from '../../scripts/run-script';
import { firstNext } from '../schedule/define';
import { SYNC } from '../scripts/schedule';
import type { WorkerContext } from './context';

/** The SYNC of each queue, by client: a promise, so a second worker waits for the first's. */
const synced = new WeakMap<RedisClient, Map<string, Promise<void>>>();

async function sync(
	context: Pick<WorkerContext, 'client' | 'definition' | 'keys'>,
): Promise<void> {
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

/**
 * Makes the stored definition schedules match the queue's, once per client and
 * queue in this process: every `work` awaits it before its first claim. A
 * failure is not remembered, so the next attempt runs it again.
 */
export function syncSchedules(
	context: Pick<WorkerContext, 'client' | 'definition' | 'keys'>,
): Promise<void> {
	let queues = synced.get(context.client);
	if (!queues) {
		queues = new Map();
		synced.set(context.client, queues);
	}
	const name = context.keys.schedules;
	let running = queues.get(name);
	if (!running) {
		running = sync(context);
		queues.set(name, running);
		running.catch(() => queues.delete(name));
	}
	return running;
}
