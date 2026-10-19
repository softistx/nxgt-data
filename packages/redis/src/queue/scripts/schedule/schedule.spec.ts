import { describe, expect, test } from 'bun:test';
import { useRedis } from '../../../../test/fixtures';
import {
	DATA,
	def,
	type Fields,
	keys,
	scheduleCalls,
} from '../../../../test/schedule-calls';
import { claim } from '../claim/claim';

const servers = useRedis();
const client = () => servers.redis.client;
const { send, hash, score, upsert, unschedule, fire, sync } =
	scheduleCalls(client);

describe('UPSERT and UNSCHEDULE', () => {
	test('upsert stores the hash as runtime and scores it', async () => {
		expect(await upsert('digest', 5000)).toBe(1);
		expect(await hash('digest')).toEqual({
			kind: 'cron',
			spec: '* * * * *',
			timezone: 'UTC',
			data: DATA,
			origin: 'runtime',
		});
		expect(await score('digest')).toBe(5000);
		await upsert('digest', 9000, 'every', '60000');
		expect(await hash('digest')).toEqual({
			kind: 'every',
			spec: '60000',
			data: DATA,
			origin: 'runtime',
		});
		expect(await score('digest')).toBe(9000);
	});

	test('upsert and unschedule refuse a definition, and change nothing', async () => {
		await sync([def('static', 1000)]);
		expect(await upsert('static', 2000)).toBe('definition');
		expect(await unschedule('static')).toBe('definition');
		expect((await hash('static')).origin).toBe('definition');
		expect((await hash('static')).spec).toBe('0 * * * *');
		expect(await score('static')).toBe(1000);
	});

	test('unschedule answers 1 for a removed schedule and 0 for none', async () => {
		await upsert('digest', 5000);
		expect(await unschedule('digest')).toBe(1);
		expect(await hash('digest')).toEqual({});
		expect(await score('digest')).toBeNull();
		expect(await unschedule('digest')).toBe(0);
	});
});

describe('FIRE', () => {
	test.each([
		['equal to due', 1000],
		['below due', 999],
	])('a next %s is an error reply and writes nothing', async (_n, next) => {
		await upsert('digest', 1000);
		let error: unknown;
		await fire('digest', 1000, next).catch((e: unknown) => {
			error = e;
		});
		expect(String(error)).toContain('next');
		expect(await send('ZCARD', keys.ready)).toBe(0);
		expect(await score('digest')).toBe(1000);
	});

	test.each([['1.5'], ['soon'], ['-5'], ['1e9']])(
		'a next of %s is an error reply and writes nothing',
		async (next) => {
			await upsert('digest', 1000);
			let error: unknown;
			await fire('digest', 1000, next as unknown as number).catch(
				(e: unknown) => {
					error = e;
				},
			);
			expect(String(error)).toContain('next');
			expect(await send('ZCARD', keys.ready)).toBe(0);
			expect(await score('digest')).toBe(1000);
		},
	);

	test('a schedule whose time has not come is never fired early', async () => {
		const future = Date.now() + 3_600_000;
		await upsert('digest', future);
		expect(await fire('digest', future, future + 60_000)).toBe(0);
		expect(await send('ZCARD', keys.ready)).toBe(0);
		expect(await score('digest')).toBe(future);
	});

	test('fires an occurrence once: copies data, attempts and timeout, leaves a wake token', async () => {
		await upsert('digest', 1000);
		expect(await fire('digest', 1000, 61_000, 2500)).toBe(1);
		const id = 'schedule:digest:1000';
		const job = (await client().hgetall(keys.job(id))) as Fields;
		expect(job.data).toBe(DATA);
		expect(job.attempts).toBe('3');
		expect(job.priority).toBe('0');
		expect(job.state).toBe('waiting');
		expect(job.timeout).toBe('2500');
		expect(await send('ZSCORE', keys.ready, id)).not.toBeNull();
		expect(await send('LLEN', keys.wake)).toBe(1);
		expect(await score('digest')).toBe(61_000);
		// The same due again, and a stale one, add nothing.
		expect(await fire('digest', 1000, 121_000)).toBe(0);
		expect(await fire('digest', 500, 121_000)).toBe(0);
		// A due the schedule has not reached is no occurrence either.
		expect(await fire('digest', 70_000, 121_000)).toBe(0);
		expect(await send('ZCARD', keys.ready)).toBe(1);
		expect(await score('digest')).toBe(61_000);
	});

	test('a job without a timeout has no timeout field', async () => {
		await upsert('digest', 1000);
		await fire('digest', 1000, 2000);
		expect(
			await client().hget(keys.job('schedule:digest:1000'), 'timeout'),
		).toBeNull();
	});

	test('fires while the queue is paused, leaving the job in ready and no wake token', async () => {
		await upsert('digest', 1000);
		await send('SET', keys.paused, '1');
		expect(await fire('digest', 1000, 2000)).toBe(1);
		expect(
			await send('ZSCORE', keys.ready, 'schedule:digest:1000'),
		).not.toBeNull();
		expect(await send('LLEN', keys.wake)).toBe(0);
	});

	test('an occurrence that already exists is left alone, and the schedule moves on', async () => {
		await upsert('digest', 1000);
		await send('HSET', keys.job('schedule:digest:1000'), 'data', '"mine"');
		expect(await fire('digest', 1000, 2000)).toBe(0);
		expect(await client().hget(keys.job('schedule:digest:1000'), 'data')).toBe(
			'"mine"',
		);
		expect(await score('digest')).toBe(2000);
	});

	test.each([
		['kind', 'missing', ['HDEL', 'kind']],
		['spec', 'missing', ['HDEL', 'spec']],
		['data', 'missing', ['HDEL', 'data']],
		['origin', 'missing', ['HDEL', 'origin']],
		['kind', 'unknown', ['HSET', 'kind', 'weekly']],
		['timezone', 'on an every', ['HSET', 'kind', 'every', 'spec', '60000']],
	])(
		'a hash with a %s %s is refused, never repaired',
		async (_f, _w, [cmd, ...rest]) => {
			await upsert('digest', 1000);
			await send(
				cmd as string,
				`${keys.schedule}digest`,
				...(rest as string[]),
			);
			const before = await hash('digest');
			expect(await fire('digest', 1000, 2000)).toBe(0);
			expect(await send('ZCARD', keys.ready)).toBe(0);
			expect(await hash('digest')).toEqual(before);
			expect(await score('digest')).toBe(1000);
		},
	);

	test('a score without a hash is refused', async () => {
		await send('ZADD', keys.schedules, '1000', 'ghost');
		expect(await fire('ghost', 1000, 2000)).toBe(0);
		expect(await send('ZCARD', keys.ready)).toBe(0);
	});
});

describe('claim and scripts together', () => {
	test('a fired occurrence is claimed as an ordinary job', async () => {
		await upsert('digest', 1000);
		await fire('digest', 1000, 61_000);
		const reply = await claim(client(), keys, 5, 30_000, undefined);
		expect(reply.jobs.map((j) => j.id)).toEqual(['schedule:digest:1000']);
		expect(reply.jobs[0]?.attempts).toBe(3);
	});
});
