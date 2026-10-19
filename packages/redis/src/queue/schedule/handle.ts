import type { RedisClient } from 'bun';
import type { z } from 'zod';
import { QueueError } from '../../errors/queue-error';
import { runScript } from '../../scripts/run-script';
import { decodeData } from '../binding/encode';
import type { queueKeys } from '../binding/keys';
import { SCHEDULES, UNSCHEDULE, UPSERT } from '../scripts/schedule/schedule';
import type { QueueDefinition } from '../types/types';
import { firstNext, ID_RULE, isScheduleId, resolveSchedule } from './define';
import type { QueueSchedules, ScheduleView } from './types';

type Keys = ReturnType<typeof queueKeys>;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** What a script answers for an id the definition owns. */
const DEFINITION = 'definition';

function ownedByDefinition(call: string, queue: string, id: string): TypeError {
	return new TypeError(
		`${call} on "${queue}": "${id}" belongs to the definition; change it in defineQueue`,
	);
}

type Definition<
	S extends z.ZodType,
	R extends z.ZodType | undefined,
> = QueueDefinition<S, R>;

/** `schedules.upsert`: stores or replaces a runtime schedule. */
async function upsert<S extends z.ZodType, R extends z.ZodType | undefined>(
	client: RedisClient,
	keys: Keys,
	definition: Definition<S, R>,
	id: string,
	schedule: Parameters<QueueSchedules<S>['upsert']>[1],
): Promise<void> {
	const { name } = definition;
	const call = 'schedules.upsert';
	const resolved = resolveSchedule(
		id,
		schedule,
		definition.schema,
		`${call} on "${name}":`,
		name,
	);
	const next = firstNext(resolved, Date.now());
	const reply = await runScript(
		client,
		UPSERT,
		[keys.schedules],
		[
			keys.schedule,
			resolved.id,
			resolved.kind,
			resolved.spec,
			resolved.timezone,
			resolved.data,
			next,
		],
	);
	if (reply === DEFINITION) throw ownedByDefinition(call, name, id);
	if (reply !== 1) {
		throw new Error('queue script reply not recognised: schedules.upsert');
	}
}

/** `schedules.remove`: removes a runtime schedule. */
async function remove<S extends z.ZodType, R extends z.ZodType | undefined>(
	client: RedisClient,
	keys: Keys,
	definition: Definition<S, R>,
	id: string,
): Promise<void> {
	const { name } = definition;
	const call = 'schedules.remove';
	if (!isScheduleId(id)) {
		throw new TypeError(`${call} on "${name}": a schedule id is ${ID_RULE}`);
	}
	const reply = await runScript(
		client,
		UNSCHEDULE,
		[keys.schedules],
		[keys.schedule, id],
	);
	if (reply === DEFINITION) throw ownedByDefinition(call, name, id);
	if (reply === 0) {
		throw new QueueError(
			'NOT_FOUND',
			name,
			`${call} on "${name}": no schedule "${id}"`,
		);
	}
	if (reply !== 1) {
		throw new Error('queue script reply not recognised: schedules.remove');
	}
}

/** `schedules.list`: one page of the stored schedules, soonest first. */
async function list<S extends z.ZodType, R extends z.ZodType | undefined>(
	client: RedisClient,
	keys: Keys,
	definition: Definition<S, R>,
	page: { offset?: number; limit?: number } | undefined,
): Promise<ScheduleView<S>[]> {
	const { name } = definition;
	const offset = page?.offset ?? 0;
	const limit = page?.limit ?? DEFAULT_LIMIT;
	if (!Number.isInteger(offset) || offset < 0) {
		throw new TypeError(
			`schedules.list on "${name}": offset is a whole number from 0`,
		);
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new TypeError(
			`schedules.list on "${name}": limit is a whole number from 1 to ${MAX_LIMIT}`,
		);
	}
	const reply = await runScript(
		client,
		SCHEDULES,
		[keys.schedules],
		[keys.schedule, offset, limit],
	);
	return toViews(definition, reply);
}

/**
 * The `schedules` of a bound queue. Like the other admin calls, none of them
 * refuses once the Redis is closed.
 */
export function scheduleHandle<
	S extends z.ZodType,
	R extends z.ZodType | undefined,
>(
	client: RedisClient,
	keys: Keys,
	definition: QueueDefinition<S, R>,
): QueueSchedules<S> {
	return {
		upsert: (id, schedule) => upsert(client, keys, definition, id, schedule),
		remove: (id) => remove(client, keys, definition, id),
		list: (page) => list(client, keys, definition, page),
	};
}

/** Maps the reply of `SCHEDULES` (the total, then one row per schedule). */
function toViews<S extends z.ZodType, R extends z.ZodType | undefined>(
	definition: QueueDefinition<S, R>,
	reply: unknown,
): ScheduleView<S>[] {
	if (!Array.isArray(reply)) {
		throw new Error('queue script reply not recognised: schedules.list');
	}
	return reply.slice(1).map((row: unknown) => {
		if (!Array.isArray(row) || row.length !== 7) {
			throw new Error('queue script reply not recognised: schedules.list');
		}
		const [id, kind, spec, timezone, data, origin, next] = row as [
			string,
			'cron' | 'every',
			string,
			string,
			string,
			'definition' | 'runtime',
			number,
		];
		const read = decodeData(definition, data);
		const view: ScheduleView<S> = {
			id,
			data: read.ok ? read.data : undefined,
			origin,
			next: new Date(next),
		};
		if (kind === 'cron') {
			view.cron = spec;
			view.timezone = timezone;
		} else {
			view.every = Number(spec);
		}
		return view;
	});
}
