import { describe, expect, test } from 'bun:test';
import { mailQueue, useRedis } from '../../../test/fixtures';
import { bindQueue } from '../binding/bind-queue';
import { queueKeys } from '../keys';
import { claim } from './claim/claim';
import { complete, fail } from './settle';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const send = (...args: string[]) => client().send(args[0] ?? '', args.slice(1));
const mails = () => bindQueue(client(), mailQueue);
const dedupe = (key: string) => `${keys.dedupe}${key}`;
const DAY = 86_400_000;

const dataOf = async (id: string) =>
	JSON.parse((await client().hget(keys.job(id), 'data')) ?? 'null').to;

/** A job waiting in `ready`, which `key` names as a debounce key would. */
async function seeded(key: string, options: { px?: number } = {}) {
	const { id } = await mails().add(
		{ to: 'seed' },
		{ priority: 5, timeout: '7s' },
	);
	await send('SET', dedupe(key), id, 'PX', String(options.px ?? 600_000));
	return id;
}

describe('debounce in ADD', () => {
	test('debounce replaces the data of a waiting job and pushes its run time', async () => {
		const id = await seeded('k');
		await send('DEL', keys.wake);

		const before = Date.now();
		const handle = await mails().add(
			{ to: 'later' },
			{ debounce: { key: 'k', wait: '1h' } },
		);

		expect({ id: handle.id, deduplicated: handle.deduplicated }).toEqual({
			id,
			deduplicated: true,
		});
		expect(await dataOf(id)).toBe('later');
		expect(await send('ZSCORE', keys.ready, id)).toBeNull();
		const due = Number(await send('ZSCORE', keys.delayed, id));
		expect(due).toBeGreaterThanOrEqual(before + 3_600_000);
		expect(due).toBeLessThanOrEqual(Date.now() + 3_600_000);
		const hash = await client().hmget(keys.job(id), [
			'state',
			'runAt',
			'priority',
			'attempts',
			'attempt',
			'timeout',
		]);
		expect(hash).toEqual(['delayed', String(due), '5', '3', '0', '7000']);
		// The new head of delayed: a blocked worker's wait was sized to nothing.
		expect(await send('LLEN', keys.wake)).toBe(1);
	});

	test('a debounced job is not due before the wait, and only one job exists', async () => {
		const first = await mails().add(
			{ to: 'a' },
			{ debounce: { key: 'k', wait: '1h' } },
		);
		const second = await mails().add(
			{ to: 'b' },
			{ debounce: { key: 'k', wait: '2h' } },
		);
		expect([first.deduplicated, second.deduplicated, second.id]).toEqual([
			false,
			true,
			first.id,
		]);
		expect(await send('ZCARD', keys.delayed)).toBe(1);
		expect(await dataOf(first.id)).toBe('b');
		expect(await send('PTTL', dedupe('k'))).toBeGreaterThan(2 * 3_600_000);
	});

	test('debounce on an active job adds a new one and leaves the running data alone', async () => {
		const id = await seeded('k');
		const claimed = await claim(client(), keys, 1, 30_000, undefined);
		expect(claimed.jobs.map((job) => job.id)).toEqual([id]);

		const handle = await mails().add(
			{ to: 'new' },
			{ debounce: { key: 'k', wait: '1h' } },
		);

		expect(handle.id).not.toBe(id);
		expect(handle.deduplicated).toBe(false);
		expect(await dataOf(id)).toBe('seed');
		expect(await client().hget(keys.job(id), 'state')).toBe('active');
		expect(await send('ZSCORE', keys.active, id)).not.toBeNull();
		expect(await send('GET', dedupe('k'))).toBe(handle.id);
	});

	test('debounce after the job finished adds a new one', async () => {
		const id = await seeded('k');
		const [job] = (await claim(client(), keys, 1, 30_000, undefined)).jobs;
		await complete(
			client(),
			keys,
			mailQueue,
			id,
			job?.token ?? '',
			undefined,
			false,
		);
		expect(await client().hget(keys.job(id), 'state')).toBe('completed');

		const handle = await mails().add(
			{ to: 'new' },
			{ debounce: { key: 'k', wait: '1h' } },
		);

		expect(handle.id).not.toBe(id);
		expect(handle.deduplicated).toBe(false);
		expect(await dataOf(id)).toBe('seed');
		expect(await send('GET', dedupe('k'))).toBe(handle.id);
	});

	test('a debounce key alone is not trusted: the job it names must be waiting', async () => {
		// A key far shorter lived than the wait, with no job behind it: new job.
		await send('SET', dedupe('k'), 'ghost', 'PX', '600000');
		const fresh = await mails().add(
			{ to: 'a' },
			{ debounce: { key: 'k', wait: '1h' } },
		);
		expect(fresh.deduplicated).toBe(false);
		expect(await send('GET', dedupe('k'))).toBe(fresh.id);

		// The same short TTL with the job waiting: the state decides, it debounces.
		const id = await seeded('j', { px: 600_000 });
		const again = await mails().add(
			{ to: 'b' },
			{ debounce: { key: 'j', wait: '1h' } },
		);
		expect([again.id, again.deduplicated]).toEqual([id, true]);
		expect(await send('PTTL', dedupe('j'))).toBeGreaterThan(DAY);
		expect(await send('PTTL', dedupe('j'))).toBeLessThanOrEqual(
			DAY + 3_600_000,
		);
	});

	test('debounce does not join a job in retry backoff: it has run, so a new one is added', async () => {
		const id = await seeded('k');
		const [job] = (await claim(client(), keys, 1, 30_000, undefined)).jobs;
		await client().hset(keys.job(id), { 'step:send': '"done"' });
		await fail(
			client(),
			keys,
			mailQueue,
			id,
			job?.token ?? '',
			{ name: 'Error', message: 'boom' },
			3_600_000,
			false,
		);
		const hash = await client().hgetall(keys.job(id));
		expect([hash['state'], hash['attempt']]).toEqual(['delayed', '1']);
		const due = await send('ZSCORE', keys.delayed, id);

		const handle = await mails().add(
			{ to: 'new' },
			{ debounce: { key: 'k', wait: '1h' } },
		);

		expect(handle.id).not.toBe(id);
		expect(handle.deduplicated).toBe(false);
		expect(await client().hgetall(keys.job(id))).toEqual(hash);
		expect(await send('ZSCORE', keys.delayed, id)).toBe(due);
		expect(await send('GET', dedupe('k'))).toBe(handle.id);
	});

	for (const fresh of [false, true]) {
		test(`debounce does not join a job put back by retry({ fresh: ${fresh} })`, async () => {
			const id = await seeded('k');
			const [job] = (await claim(client(), keys, 1, 30_000, undefined)).jobs;
			await client().hset(keys.job(id), { 'step:send': '"done"' });
			await fail(
				client(),
				keys,
				mailQueue,
				id,
				job?.token ?? '',
				{ name: 'Error', message: 'boom' },
				null,
				false,
			);
			await mails().retry(id, { fresh });
			const hash = await client().hgetall(keys.job(id));
			expect([hash['state'], hash['attempt'], hash['retried']]).toEqual([
				'waiting',
				'0',
				'1',
			]);
			expect(hash['step:send'] === undefined).toBe(fresh);

			const handle = await mails().add(
				{ to: 'new' },
				{ debounce: { key: 'k', wait: '1h' } },
			);

			expect(handle.id).not.toBe(id);
			expect(handle.deduplicated).toBe(false);
			expect(await client().hgetall(keys.job(id))).toEqual(hash);
			expect(await send('ZSCORE', keys.ready, id)).not.toBeNull();
			expect(await send('GET', dedupe('k'))).toBe(handle.id);
		});
	}

	test('a key that names a hash this script could not have written adds a new job and leaves it alone', async () => {
		// Each hash says waiting or delayed but lacks what ADD always wrote
		// (a priority) or is missing from the zset its state puts it in.
		const odd: Record<string, [Record<string, string>, string | undefined]> = {
			nopriority: [{ state: 'waiting', data: 'x' }, keys.ready],
			notready: [{ state: 'waiting', data: 'x', priority: '0' }, undefined],
			notdelayed: [{ state: 'delayed', data: 'x', priority: '0' }, undefined],
			wrongset: [{ state: 'delayed', data: 'x', priority: '0' }, keys.ready],
		};
		for (const [id, [hash, zset]] of Object.entries(odd)) {
			await client().hset(keys.job(id), hash);
			if (zset !== undefined) await send('ZADD', zset, '1', id);
			await send('SET', dedupe(id), id, 'PX', '600000');

			const handle = await mails().add(
				{ to: 'a' },
				{ debounce: { key: id, wait: '1h' } },
			);

			expect([id, handle.deduplicated]).toEqual([id, false]);
			expect(handle.id).not.toBe(id);
			expect(await client().hgetall(keys.job(id))).toEqual(hash);
			expect(await send('GET', dedupe(id))).toBe(handle.id);
		}
		expect(await send('ZSCORE', keys.delayed, 'wrongset')).toBeNull();
		expect(await send('ZSCORE', keys.ready, 'wrongset')).toBe(1);
	});

	test('a debounce hit refreshes the PX of the key to the wait plus a day', async () => {
		const id = await seeded('k', { px: 5_000 });
		await mails().add({ to: 'x' }, { debounce: { key: 'k', wait: 1000 } });
		const ttl = Number(await send('PTTL', dedupe('k')));
		expect(ttl).toBeGreaterThan(DAY);
		expect(await send('GET', dedupe('k'))).toBe(id);
	});
});

describe('throttle in ADD', () => {
	test('a stored key that is not an id is read as no key', async () => {
		for (const bad of ['', '{x}', 'a}', 'x'.repeat(257)]) {
			await send('SET', dedupe('k'), bad, 'PX', '600000');
			const handle = await mails().add(
				{ to: 'a' },
				{ throttle: { key: 'k', window: '1h' } },
			);
			expect([bad.length, handle.deduplicated]).toEqual([bad.length, false]);
			expect(await send('GET', dedupe('k'))).toBe(handle.id);
			expect(await send('PTTL', dedupe('k'))).toBeLessThanOrEqual(3_600_000);
		}
	});

	test('throttle keeps the first and answers its id within the window, even once it finished', async () => {
		const first = await mails().add(
			{ to: 'a' },
			{ throttle: { key: 'digest', window: '1h' } },
		);
		const [job] = (await claim(client(), keys, 1, 30_000, undefined)).jobs;
		await complete(
			client(),
			keys,
			mailQueue,
			first.id,
			job?.token ?? '',
			undefined,
			false,
		);

		const second = await mails().add(
			{ to: 'b' },
			{ throttle: { key: 'digest', window: '1h' } },
		);

		expect(first.deduplicated).toBe(false);
		expect([second.id, second.deduplicated]).toEqual([first.id, true]);
		expect(await dataOf(first.id)).toBe('a');
		expect(await send('GET', dedupe('digest'))).toBe(first.id);
		const ttl = Number(await send('PTTL', dedupe('digest')));
		expect(ttl).toBeGreaterThan(3_500_000);
		expect(ttl).toBeLessThanOrEqual(3_600_000);
	});

	test('throttle after the window adds again', async () => {
		const first = await mails().add(
			{ to: 'a' },
			{ throttle: { key: 'k', window: 100 } },
		);
		await Bun.sleep(150);
		const second = await mails().add(
			{ to: 'b' },
			{ throttle: { key: 'k', window: 100 } },
		);
		expect(second.deduplicated).toBe(false);
		expect(second.id).not.toBe(first.id);
		expect(await send('GET', dedupe('k'))).toBe(second.id);
	});

	test('throttle may carry a delay, which the first job keeps', async () => {
		const handle = await mails().add(
			{ to: 'a' },
			{ throttle: { key: 'k', window: '1h' }, delay: '10m' },
		);
		expect(await send('ZSCORE', keys.delayed, handle.id)).not.toBeNull();
	});
});
