import type { RedisClient } from 'bun';
import { runScript } from '../../scripts/run-script';
import { queueKeys } from '../keys';
import { scriptKeys } from './claim';
import { FIRE, SYNC, UNSCHEDULE, UPSERT } from './schedule';

/** Test helpers: the schedule scripts called as the client will call them. */
export const keys = queueKeys('mails');

/** A schedule's data, as the client stores it. */
export const DATA = '{"to":"a@b.c"}';

/** The fields of a schedule or job hash these specs read. */
export type Fields = Partial<
	Record<
		| 'kind'
		| 'spec'
		| 'timezone'
		| 'data'
		| 'origin'
		| 'attempts'
		| 'priority'
		| 'state'
		| 'timeout',
		string
	>
>;

/** A syncable definition: id, kind, spec, timezone, data, next. */
export type Def = [string, string, string, string, string, number];

/** A cron definition at `next`. */
export const def = (id: string, next: number, spec = '0 * * * *'): Def => [
	id,
	'cron',
	spec,
	'UTC',
	DATA,
	next,
];

/** The scripts bound to a client, with readers of the stored state. */
export function scheduleCalls(client: () => RedisClient) {
	const send = (...args: string[]) =>
		client().send(args[0] ?? '', args.slice(1));
	return {
		send,
		hash: async (id: string) =>
			(await client().hgetall(`${keys.schedule}${id}`)) as Fields,
		score: (id: string) => send('ZSCORE', keys.schedules, id),
		upsert: (id: string, next: number, kind = 'cron', spec = '* * * * *') =>
			runScript(
				client(),
				UPSERT,
				[keys.schedules],
				[
					keys.schedule,
					id,
					kind,
					spec,
					kind === 'cron' ? 'UTC' : '',
					DATA,
					next,
				],
			),
		unschedule: (id: string) =>
			runScript(client(), UNSCHEDULE, [keys.schedules], [keys.schedule, id]),
		fire: (id: string, due: number, next: number, timeout = -1) =>
			runScript(client(), FIRE, scriptKeys(keys), [
				keys.prefix,
				keys.schedule,
				id,
				due,
				next,
				3,
				timeout,
			]),
		sync: (defs: Def[]) =>
			runScript(
				client(),
				SYNC,
				[keys.schedules],
				[keys.schedule, ...defs.flat()],
			),
	};
}
