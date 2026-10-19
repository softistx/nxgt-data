import type { z } from 'zod';
import { QueueError } from '../../errors/queue-error';
import { durationMs } from '../definition/duration';
import { MAX_NAME } from '../definition/name';
import { toJson } from '../round-trip';
import { parseCron } from './cron';
import { nextAfter } from './next';
import type { ScheduleDefinition } from './types';
import { checkZone } from './zone';

/** The most schedules a definition may hold: what one SYNC takes. */
export const MAX_SCHEDULES = 1000;

/** The shortest interval. */
const MIN_EVERY = 1000;

/** The longest interval: what the stored `spec` may hold, 15 digits. */
const MAX_EVERY = 999_999_999_999_999;

/** The text of the refusal for a schedule id. */
export const ID_RULE = `a string of 1 to ${MAX_NAME} characters without braces or colons`;

/** Whether `id` is usable as a schedule id. */
export function isScheduleId(id: unknown): id is string {
	return (
		typeof id === 'string' &&
		id.length > 0 &&
		id.length <= MAX_NAME &&
		!/[{}:]/.test(id)
	);
}

/**
 * Checks one schedule and resolves it. `lead` opens every message: the call
 * and the queue, as `defineQueue: "mails"` or `schedules.upsert on "mails":`.
 * A malformed schedule is a bare `TypeError`; data the schema refuses is a
 * `QueueError` `INVALID`. No message quotes the data.
 */
export function resolveSchedule(
	id: unknown,
	schedule: unknown,
	schema: z.ZodType,
	lead: string,
	queue: string,
): ScheduleDefinition {
	if (!isScheduleId(id)) {
		throw new TypeError(`${lead} a schedule id is ${ID_RULE}`);
	}
	const refuse = (what: string): never => {
		throw new TypeError(`${lead} schedule "${id}" ${what}`);
	};
	if (schedule === null || typeof schedule !== 'object') {
		return refuse('is not an object with cron or every, and data');
	}
	const { cron, every, timezone, data } = schedule as Record<string, unknown>;
	if (cron !== undefined && every !== undefined) {
		refuse('has both cron and every; give one');
	}
	if (cron === undefined && every === undefined) {
		refuse('has neither cron nor every; give one');
	}
	if (every !== undefined && timezone !== undefined) {
		refuse('has a timezone with every; a timezone goes with a cron');
	}
	const refused = (detail: string) =>
		new QueueError('INVALID', queue, `${lead} schedule "${id}" ${detail}`);
	const json = (): string =>
		toJson(schema, data, refused, 'data ', 'the schema');
	if (every !== undefined) {
		const everyMs = everyOf(every, refuse);
		return Object.freeze({
			id,
			kind: 'every',
			spec: String(everyMs),
			timezone: '',
			data: json(),
			everyMs,
		});
	}
	if (typeof cron !== 'string') {
		return refuse('has a cron that is not text');
	}
	if (timezone !== undefined && typeof timezone !== 'string') {
		return refuse('has a timezone that is not text');
	}
	const zone = timezone ?? 'UTC';
	try {
		checkZone(zone);
		return Object.freeze({
			id,
			kind: 'cron',
			spec: cron,
			timezone: zone,
			data: json(),
			cron: parseCron(cron),
		});
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		throw new TypeError(`${lead} schedule "${id}": ${error.message}`);
	}
}

function everyOf(every: unknown, refuse: (what: string) => never): number {
	const ms = durationMs(every);
	if (ms === undefined) {
		return refuse(
			"has an every that is not a duration; it is a whole number of milliseconds or a string such as '10m'",
		);
	}
	if (ms < MIN_EVERY) {
		return refuse('has an every under 1 second; it is at least 1s');
	}
	if (ms > MAX_EVERY) {
		return refuse(`has an every above ${MAX_EVERY} ms`);
	}
	return ms;
}

/**
 * The static schedules of a definition, resolved and frozen, in the order
 * given.
 *
 * @throws TypeError for more than {@link MAX_SCHEDULES}, or any malformed one.
 */
export function resolveSchedules(
	input: unknown,
	schema: z.ZodType,
	call: string,
	name: string,
): readonly ScheduleDefinition[] {
	if (input === undefined) return Object.freeze([]);
	const lead = `${call}: "${name}"`;
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError(
			`${lead} schedules is an object of schedule id to schedule`,
		);
	}
	const entries = Object.entries(input);
	if (entries.length > MAX_SCHEDULES) {
		throw new TypeError(
			`${lead} has ${entries.length} schedules; at most ${MAX_SCHEDULES}, which is what one sync takes`,
		);
	}
	return Object.freeze(
		entries.map(([id, schedule]) =>
			resolveSchedule(id, schedule, schema, lead, name),
		),
	);
}

/**
 * The schedules of a definition already resolved, as `bindQueue` checks one
 * written by hand: a list of {@link ScheduleDefinition}s, or none.
 *
 * @throws TypeError for anything else.
 */
export function checkResolved(
	input: unknown,
	call: string,
	name: string,
): readonly ScheduleDefinition[] {
	if (input === undefined) return Object.freeze([]);
	if (
		!Array.isArray(input) ||
		input.length > MAX_SCHEDULES ||
		!input.every(isResolved)
	) {
		throw new TypeError(
			`${call}: "${name}" has schedules that are not the ones defineQueue resolves`,
		);
	}
	return Object.freeze([...(input as ScheduleDefinition[])]);
}

function isResolved(value: unknown): boolean {
	const s = value as Partial<ScheduleDefinition> | null;
	return (
		typeof s === 'object' &&
		s !== null &&
		isScheduleId(s.id) &&
		(s.kind === 'cron' || s.kind === 'every') &&
		typeof s.spec === 'string' &&
		typeof s.data === 'string'
	);
}

/**
 * The first occurrence of a schedule made now: the next match of a cron after
 * `now`, or `now` plus the interval.
 */
export function firstNext(schedule: ScheduleDefinition, now: number): number {
	return schedule.kind === 'cron'
		? nextAfter(schedule.cron, schedule.timezone, now)
		: now + schedule.everyMs;
}
