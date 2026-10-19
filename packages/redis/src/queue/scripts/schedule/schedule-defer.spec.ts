import { describe, expect, test } from 'bun:test';
import { useRedis } from '../../../../test/fixtures';
import { rejection } from '../../../../test/rejection';
import { keys, scheduleCalls } from '../../../../test/schedule-calls';

const servers = useRedis();
const client = () => servers.redis.client;
const { send, score, upsert, defer } = scheduleCalls(client);

describe('DEFER', () => {
	test('moves a schedule still scored at due to until, and adds no job', async () => {
		await upsert('s', 1000);
		expect(await defer('s', 1000, 3_601_000)).toBe(1);
		expect(await score('s')).toBe(3_601_000);
		expect(await send('KEYS', `${keys.prefix}*`)).toEqual([]);
		expect(await send('ZCARD', keys.ready)).toBe(0);
	});

	test('does nothing when the score moved, or the schedule is gone', async () => {
		await upsert('s', 2000);
		expect(await defer('s', 1000, 9000)).toBe(0);
		expect(await score('s')).toBe(2000);
		expect(await defer('none', 1000, 9000)).toBe(0);
		expect(await score('none')).toBeNull();
	});

	test('leaves a hash it could not have written alone', async () => {
		await upsert('s', 1000);
		await send('HDEL', `${keys.schedule}s`, 'origin');
		expect(await defer('s', 1000, 9000)).toBe(0);
		expect(await score('s')).toBe(1000);
	});

	test.each([
		['equal to due', 1000],
		['below due', 999],
	])('an until %s is an error reply and writes nothing', async (_n, until) => {
		await upsert('s', 1000);
		const refused = await rejection(defer('s', 1000, until));
		expect(String(refused)).toContain(
			'until must be a whole number of ms after due',
		);
		expect(await score('s')).toBe(1000);
	});

	test('a fractional or negative until is refused too', async () => {
		await upsert('s', 1000);
		for (const until of ['1500.5', '-5', '1e5', 'abc']) {
			expect(
				String(await rejection(defer('s', 1000, until as never))),
			).toContain('until must be a whole number');
		}
		expect(await score('s')).toBe(1000);
	});
});
