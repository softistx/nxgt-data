import { describe, expect, test } from 'bun:test';
import { useRedis } from '../../../test/fixtures';
import { runScript } from '../../scripts/run-script';
import { SCHEDULES } from './schedule';
import { DATA, type Def, def, keys, scheduleCalls } from './schedule-calls';

const servers = useRedis();
const client = () => servers.redis.client;
const { send, hash, score, upsert, sync } = scheduleCalls(client);

describe('SYNC', () => {
	test('adds definitions, with origin definition', async () => {
		expect(await sync([def('a', 1000), def('b', 2000)])).toEqual([2, 0]);
		expect((await hash('a')).origin).toBe('definition');
		expect(await score('a')).toBe(1000);
		expect(await score('b')).toBe(2000);
	});

	test('keeps the score when kind, spec and timezone are unchanged, resets it when one changed', async () => {
		await sync([def('a', 1000), def('b', 1000), def('c', 1000)]);
		await send('ZADD', keys.schedules, '7777', 'a');
		await send('ZADD', keys.schedules, '7777', 'b');
		await send('ZADD', keys.schedules, '7777', 'c');
		const changed: Def = ['c', 'cron', '0 * * * *', 'Europe/Paris', DATA, 5000];
		await sync([def('a', 9000), def('b', 9000, '5 * * * *'), changed]);
		expect(await score('a')).toBe(7777);
		expect(await score('b')).toBe(9000);
		expect(await score('c')).toBe(5000);
		expect((await hash('b')).spec).toBe('5 * * * *');
		expect((await hash('c')).timezone).toBe('Europe/Paris');
	});

	test('updates data without touching the score, and drops a stale timezone on an every', async () => {
		await sync([def('a', 1000)]);
		await send('ZADD', keys.schedules, '7777', 'a');
		await sync([['a', 'cron', '0 * * * *', 'UTC', '{"to":"z"}', 9000]]);
		expect((await hash('a')).data).toBe('{"to":"z"}');
		expect(await score('a')).toBe(7777);
		await sync([['a', 'every', '60000', '', '{"to":"z"}', 3000]]);
		expect(await hash('a')).toEqual({
			kind: 'every',
			spec: '60000',
			data: '{"to":"z"}',
			origin: 'definition',
		});
		expect(await score('a')).toBe(3000);
	});

	test('removes definitions that are gone and leaves runtime ones', async () => {
		await sync([def('a', 1000), def('b', 1000)]);
		await upsert('mine', 4000);
		expect(await sync([def('a', 1000)])).toEqual([1, 1]);
		expect(await hash('b')).toEqual({});
		expect(await score('b')).toBeNull();
		expect((await hash('mine')).origin).toBe('runtime');
		expect(await score('mine')).toBe(4000);
		await sync([]);
		expect(await score('a')).toBeNull();
		expect(await score('mine')).toBe(4000);
	});

	test('a definition takes over a runtime schedule of the same id', async () => {
		await upsert('a', 4000);
		await sync([def('a', 1000)]);
		expect((await hash('a')).origin).toBe('definition');
		expect(await upsert('a', 4000)).toBe('definition');
	});

	test('refuses more than 1000 schedules in a call, and writes nothing', async () => {
		const many = Array.from({ length: 1001 }, (_, i) => def(`s${i}`, 1000));
		let error: unknown;
		await sync(many).catch((e: unknown) => {
			error = e;
		});
		expect(String(error)).toContain('1000');
		expect(await send('ZCARD', keys.schedules)).toBe(0);
		expect(await sync(many.slice(0, 1000))).toEqual([1000, 0]);
	});
});

describe('SCHEDULES', () => {
	test('lists in order of next occurrence, paginated, with the total', async () => {
		await sync([def('b', 2000)]);
		await upsert('a', 3000, 'every', '60000');
		await upsert('c', 1000);
		const page = (offset: number, limit: number) =>
			runScript(
				client(),
				SCHEDULES,
				[keys.schedules],
				[keys.schedule, offset, limit],
			);
		expect(await page(0, 2)).toEqual([
			3,
			['c', 'cron', '* * * * *', 'UTC', DATA, 'runtime', 1000],
			['b', 'cron', '0 * * * *', 'UTC', DATA, 'definition', 2000],
		]);
		expect(await page(2, 2)).toEqual([
			3,
			['a', 'every', '60000', '', DATA, 'runtime', 3000],
		]);
		expect(await page(9, 2)).toEqual([3]);
	});

	test('skips a hash it could not have written, and caps the limit at 1000', async () => {
		await upsert('ok', 1000);
		await send('ZADD', keys.schedules, '500', 'ghost');
		const reply = (await runScript(
			client(),
			SCHEDULES,
			[keys.schedules],
			[keys.schedule, 0, 5000],
		)) as unknown[];
		expect(reply[0]).toBe(2);
		expect(reply.slice(1).map((e) => (e as string[])[0])).toEqual(['ok']);
	});
});
