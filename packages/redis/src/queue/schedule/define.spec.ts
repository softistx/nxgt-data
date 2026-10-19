import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { QueueError } from '../../errors/queue-error';
import { defineQueue } from '../define-queue';

const schema = z.object({ to: z.string(), n: z.number().default(1) });
const data = { to: 'a@b.c' };

/** The message `defineQueue` refuses these schedules with. */
function refusal(schedules: Record<string, unknown>): string {
	try {
		defineQueue({ name: 'mails', schema, schedules: schedules as never });
	} catch (error) {
		expect(error).toBeInstanceOf(TypeError);
		return (error as Error).message;
	}
	throw new Error('expected a refusal');
}

describe('defineQueue({ schedules })', () => {
	test('resolves and freezes the schedules, data as its stored JSON', () => {
		const q = defineQueue({
			name: 'mails',
			schema,
			schedules: {
				daily: { cron: '0 7 * * *', timezone: 'Europe/Paris', data },
				often: { every: '90s', data },
				utc: { cron: '*/5 * * * *', data },
			},
		});
		expect(q.schedules.map((s) => [s.id, s.kind, s.spec, s.timezone])).toEqual([
			['daily', 'cron', '0 7 * * *', 'Europe/Paris'],
			['often', 'every', '90000', ''],
			['utc', 'cron', '*/5 * * * *', 'UTC'],
		]);
		expect(q.schedules[0]?.data).toBe('{"to":"a@b.c","n":1}');
		expect(Object.isFrozen(q.schedules)).toBe(true);
		expect(Object.isFrozen(q.schedules[0])).toBe(true);
		expect(q.schedules[0]).toMatchObject({ kind: 'cron' });
		expect(q.schedules[1]).toMatchObject({ kind: 'every', everyMs: 90_000 });
	});

	test('no schedules is an empty list', () => {
		expect(defineQueue({ name: 'm', schema }).schedules).toEqual([]);
	});

	test('refuses a cron with an every', () => {
		expect(refusal({ a: { cron: '* * * * *', every: '1m', data } })).toBe(
			'defineQueue: "mails" schedule "a" has both cron and every; give one',
		);
	});

	test('refuses neither', () => {
		expect(refusal({ a: { data } })).toBe(
			'defineQueue: "mails" schedule "a" has neither cron nor every; give one',
		);
	});

	test('refuses a timezone with every', () => {
		expect(refusal({ a: { every: '1m', timezone: 'UTC', data } })).toBe(
			'defineQueue: "mails" schedule "a" has a timezone with every; a timezone goes with a cron',
		);
	});

	test('refuses a zone Intl does not know, naming it', () => {
		expect(
			refusal({ a: { cron: '* * * * *', timezone: 'Mars/Base', data } }),
		).toContain('"Mars/Base"');
	});

	test('refuses a cron that does not parse, naming the schedule', () => {
		expect(refusal({ a: { cron: '61 * * * *', data } })).toStartWith(
			'defineQueue: "mails" schedule "a": ',
		);
	});

	test('refuses an every under one second', () => {
		expect(refusal({ a: { every: '500ms', data } })).toBe(
			'defineQueue: "mails" schedule "a" has an every under 1 second; it is at least 1s',
		);
	});

	test('refuses an every that is not a duration', () => {
		expect(refusal({ a: { every: '5 minutes', data } })).toBe(
			'defineQueue: "mails" schedule "a" has an every that is not a duration; it is a whole number of milliseconds or a string such as \'10m\'',
		);
	});

	test.each([['a:b'], [''], ['a{b}'], ['x'.repeat(257)]])(
		'refuses the id %p',
		(id) => {
			expect(refusal({ [id]: { every: '1m', data } })).toBe(
				'defineQueue: "mails" a schedule id is a string of 1 to 256 characters without braces or colons',
			);
		},
	);

	test('refuses data the schema refuses, as QueueError INVALID, never quoting it', () => {
		try {
			defineQueue({
				name: 'mails',
				schema,
				schedules: { a: { every: '1m', data: { to: 42 } as never } },
			});
			throw new Error('expected a refusal');
		} catch (error) {
			expect(error).toBeInstanceOf(QueueError);
			const refused = error as QueueError;
			expect(refused.code).toBe('INVALID');
			expect(refused.queue).toBe('mails');
			expect(refused.message).toStartWith(
				'defineQueue: "mails" schedule "a" data does not match the schema',
			);
			expect(refused.message).not.toContain('42');
		}
	});

	test('refuses more than 1000 schedules, and takes 1000', () => {
		const many = (n: number) =>
			Object.fromEntries(
				Array.from({ length: n }, (_, i) => [
					`s${i}`,
					{ every: '1m' as const, data },
				]),
			);
		expect(refusal(many(1001))).toBe(
			'defineQueue: "mails" has 1001 schedules; at most 1000, which is what one sync takes',
		);
		expect(
			defineQueue({ name: 'm', schema, schedules: many(1000) }).schedules,
		).toHaveLength(1000);
	});

	test('refuses schedules that are not an object of schedules', () => {
		expect(() =>
			defineQueue({ name: 'm', schema, schedules: [] as never }),
		).toThrow(
			'defineQueue: "m" schedules is an object of schedule id to schedule',
		);
		expect(refusal({ a: null })).toBe(
			'defineQueue: "mails" schedule "a" is not an object with cron or every, and data',
		);
	});
});
