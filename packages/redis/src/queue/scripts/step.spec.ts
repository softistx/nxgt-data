import { describe, expect, test } from 'bun:test';
import { mailQueue, useRedis } from '../../../test/fixtures';
import { bindQueue } from '../binding/bind-queue';
import { queueKeys } from '../binding/keys';
import { claim } from './claim/claim';
import { stepBegin, stepCommit } from './step';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const send = (...args: string[]) => client().send(args[0] ?? '', args.slice(1));
const hget = (id: string, field: string) => client().hget(keys.job(id), field);
const score = async (id: string) =>
	Number(await send('ZSCORE', keys.active, id));
const STALE = '0'.repeat(32);

async function take(id: string) {
	await bindQueue(client(), mailQueue).add({ to: id }, { id });
	const job = (await claim(client(), keys, 1, 30_000, undefined)).jobs.find(
		(j) => j.id === id,
	);
	if (!job) throw new Error(`${id} was not claimed`);
	return job;
}

describe('steps', () => {
	test('BEGIN on a fresh step allows the run and pushes the lease', async () => {
		const job = await take('a');
		await send('ZADD', keys.active, String(Date.now() + 2_000), 'a');
		const reply = await stepBegin(
			client(),
			keys,
			'a',
			job.token,
			'one',
			60_000,
		);
		expect(reply).toEqual({ stored: false });
		const left = (await score('a')) - Date.now();
		expect(left).toBeGreaterThan(50_000);
		expect(left).toBeLessThanOrEqual(60_000);
		expect(await hget('a', 'step:one')).toBeNull();
	});

	test('BEGIN on a stored step answers its JSON and does not touch the lease', async () => {
		const job = await take('a');
		await send('HSET', keys.job('a'), 'step:one', '{"n":1}');
		await send('ZADD', keys.active, String(Date.now() + 2_000), 'a');
		const before = await score('a');
		const reply = await stepBegin(
			client(),
			keys,
			'a',
			job.token,
			'one',
			60_000,
		);
		expect(reply).toEqual({ stored: true, json: '{"n":1}' });
		expect(await score('a')).toBe(before);
	});

	test('BEGIN with a stale token answers lost', async () => {
		await take('a');
		const before = await score('a');
		expect(await stepBegin(client(), keys, 'a', STALE, 'one', 60_000)).toEqual({
			lost: true,
		});
		expect(await score('a')).toBe(before);
	});

	test('BEGIN on a stored step with a stale token answers lost, not the value', async () => {
		await take('a');
		await send('HSET', keys.job('a'), 'step:one', '1');
		expect(await stepBegin(client(), keys, 'a', STALE, 'one', 60_000)).toEqual({
			lost: true,
		});
	});

	test('BEGIN after the lease lapsed answers lost, though the token holds', async () => {
		const job = await take('a');
		await send('ZADD', keys.active, String(Date.now() - 1_000), 'a');
		expect(
			await stepBegin(client(), keys, 'a', job.token, 'one', 60_000),
		).toEqual({ lost: true });
		expect(await score('a')).toBeLessThan(Date.now());
	});

	test('BEGIN on a job not in active answers lost', async () => {
		const job = await take('a');
		await send('ZREM', keys.active, 'a');
		expect(
			await stepBegin(client(), keys, 'a', job.token, 'one', 60_000),
		).toEqual({ lost: true });
		expect(await send('ZSCORE', keys.active, 'a')).toBeNull();
		await send('DEL', keys.job('a'));
		expect(
			await stepBegin(client(), keys, 'a', job.token, 'one', 60_000),
		).toEqual({ lost: true });
	});

	test('COMMIT stores the value only while token and lease hold', async () => {
		const job = await take('a');
		expect(await stepCommit(client(), keys, 'a', job.token, 'one', '1')).toBe(
			true,
		);
		expect(await hget('a', 'step:one')).toBe('1');
		expect(await stepCommit(client(), keys, 'a', STALE, 'two', '2')).toBe(
			false,
		);
		expect(await hget('a', 'step:two')).toBeNull();
		await send('ZADD', keys.active, String(Date.now() - 1_000), 'a');
		expect(await stepCommit(client(), keys, 'a', job.token, 'three', '3')).toBe(
			false,
		);
		expect(await hget('a', 'step:three')).toBeNull();
		await send('ZREM', keys.active, 'a');
		expect(await stepCommit(client(), keys, 'a', job.token, 'four', '4')).toBe(
			false,
		);
		expect(await hget('a', 'step:four')).toBeNull();
	});

	test("a stale COMMIT never overwrites the live attempt's value", async () => {
		const job = await take('a');
		await send('HSET', keys.job('a'), 'token', 'live'.padEnd(32, '0'));
		await stepCommit(
			client(),
			keys,
			'a',
			'live'.padEnd(32, '0'),
			'one',
			'"live"',
		);
		expect(
			await stepCommit(client(), keys, 'a', job.token, 'one', '"old"'),
		).toBe(false);
		expect(await hget('a', 'step:one')).toBe('"live"');
	});

	test('COMMIT under the fence replaces a value an earlier attempt stored', async () => {
		const job = await take('a');
		await send('HSET', keys.job('a'), 'step:one', '"old"');
		expect(
			await stepCommit(client(), keys, 'a', job.token, 'one', '"new"'),
		).toBe(true);
		expect(await hget('a', 'step:one')).toBe('"new"');
	});

	test('COMMIT of the empty string stores it', async () => {
		const job = await take('a');
		expect(await stepCommit(client(), keys, 'a', job.token, 'one', '')).toBe(
			true,
		);
		expect(await hget('a', 'step:one')).toBe('');
		expect(
			await stepBegin(client(), keys, 'a', job.token, 'one', 60_000),
		).toEqual({
			stored: true,
			json: '',
		});
	});
});
