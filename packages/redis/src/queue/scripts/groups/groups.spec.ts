import { describe, expect, test } from 'bun:test';
import { useRedis } from '../../../../test/fixtures';
import {
	addGrouped,
	expectGroupState,
	grouped,
	scan,
} from '../../../../test/group-state';
import { queueKeys } from '../../keys';
import { claim } from '../claim/claim';
import { complete, fail } from '../settle';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const boom = { name: 'x', message: 'boom' };
const CAP = 1;
const definition = grouped(CAP);
const cap = { concurrency: CAP };
const llen = async (key: string) => Number(await client().send('LLEN', [key]));
const zrange = async (key: string) =>
	(await client().send('ZRANGE', [key, '0', '-1'])) as string[];
const listed = () => zrange(`${keys.group}A:ready`);
const take = async (n = 1) =>
	await claim(client(), keys, n, 30_000, undefined, cap);

/** Adds `ids` to group A and claims the first. */
async function started(...ids: string[]) {
	await addGrouped(
		client(),
		keys,
		CAP,
		ids.map((id) => ({ id, group: 'A' })),
	);
	const reply = await take();
	const first = reply.jobs[0];
	if (!first) throw new Error('nothing claimed');
	return first;
}

describe('grouped add', () => {
	test('a named group stores its name and mirrors ready', async () => {
		await addGrouped(client(), keys, CAP, [
			{ id: 'a1', group: 'A' },
			{ id: 'd1', group: '' },
		]);
		expect(await client().hget(keys.job('a1'), 'group')).toBe('A');
		expect(await client().hget(keys.job('d1'), 'group')).toBeNull();
		expect(await listed()).toEqual(['a1']);
		expect(await zrange(`${keys.group}:ready`)).toEqual(['d1']);
		expect(
			await client().send('LRANGE', [keys.groupsReady, '0', '-1']),
		).toEqual(['A', '']);
		await expectGroupState(client(), keys, CAP);
	});

	test('an add into a full group leaves no wake token and no list entry', async () => {
		await started('a1');
		expect(await llen(keys.wake)).toBe(0);
		await addGrouped(client(), keys, CAP, [{ id: 'a2', group: 'A' }]);
		expect(await llen(keys.wake)).toBe(0);
		expect(await llen(keys.groupsReady)).toBe(0);
		await expectGroupState(client(), keys, CAP);
	});

	test('an add into a claimable group leaves the token', async () => {
		await addGrouped(client(), keys, CAP, [{ id: 'a1', group: 'A' }]);
		expect(await llen(keys.wake)).toBe(1);
	});

	test('a group with no free slot is not queued by a new job', async () => {
		await started('a1');
		await addGrouped(client(), keys, CAP, [{ id: 'a2', group: 'A' }]);
		expect(await llen(keys.groupsReady)).toBe(0);
		expect(await listed()).toEqual(['a2']);
		await expectGroupState(client(), keys, CAP);
	});
});

describe('settle frees the slot', () => {
	test('complete frees it, queues the group and leaves a wake token', async () => {
		const first = await started('a1', 'a2');
		expect(await llen(keys.wake)).toBe(0);
		const done = await complete(
			client(),
			keys,
			definition,
			'a1',
			first.token,
			undefined,
			false,
		);
		expect(done.settled).toBe(true);
		expect(await client().get(`${keys.group}A:active`)).toBeNull();
		expect(
			await client().send('LRANGE', [keys.groupsReady, '0', '-1']),
		).toEqual(['A']);
		expect(await llen(keys.wake)).toBe(1);
		await expectGroupState(client(), keys, CAP);
		expect((await take()).jobs.map((j) => j.id)).toEqual(['a2']);
	});

	test('complete with a claim hands the freed slot to the next job', async () => {
		const first = await started('a1', 'a2');
		const done = await complete(
			client(),
			keys,
			definition,
			'a1',
			first.token,
			undefined,
			true,
		);
		expect(done.jobs.map((j) => j.id)).toEqual(['a2']);
		expect(await client().get(`${keys.group}A:active`)).toBe('1');
		await expectGroupState(client(), keys, CAP);
	});

	test('a settle that makes nothing claimable leaves no token', async () => {
		const first = await started('a1');
		await complete(
			client(),
			keys,
			definition,
			'a1',
			first.token,
			undefined,
			false,
		);
		expect(await llen(keys.wake)).toBe(0);
		expect(await llen(keys.groupsReady)).toBe(0);
		await expectGroupState(client(), keys, CAP);
	});

	test('fail with a retry frees it and the job returns to its group when promoted', async () => {
		const first = await started('a1', 'a2');
		const failed = await fail(
			client(),
			keys,
			definition,
			'a1',
			first.token,
			boom,
			60_000,
			false,
		);
		expect(failed.final).toBe(false);
		expect(await client().zscore(keys.delayed, 'a1')).not.toBeNull();
		expect(await client().get(`${keys.group}A:active`)).toBeNull();
		expect(await llen(keys.wake)).toBe(1);
		await expectGroupState(client(), keys, CAP);
		await client().send('ZADD', [keys.delayed, '0', 'a1']);
		expect((await take()).jobs.map((j) => j.id)).toEqual(['a2']);
		expect(await listed()).toEqual(['a1']);
		await expectGroupState(client(), keys, CAP);
	});

	test('a final fail frees it too', async () => {
		const first = await started('a1', 'a2');
		await fail(
			client(),
			keys,
			definition,
			'a1',
			first.token,
			boom,
			null,
			false,
		);
		expect(await client().get(`${keys.group}A:active`)).toBeNull();
		expect(await llen(keys.groupsReady)).toBe(1);
		await expectGroupState(client(), keys, CAP);
	});

	test('a settle whose id is no longer active frees nothing', async () => {
		const first = await started('a1');
		await client().send('ZREM', [keys.active, 'a1']);
		await complete(
			client(),
			keys,
			definition,
			'a1',
			first.token,
			undefined,
			false,
		);
		expect(await client().get(`${keys.group}A:active`)).toBe('1');
	});

	test('a fail whose id is no longer active frees nothing', async () => {
		const first = await started('a1');
		await client().send('ZREM', [keys.active, 'a1']);
		await fail(
			client(),
			keys,
			definition,
			'a1',
			first.token,
			boom,
			null,
			false,
		);
		expect(await client().get(`${keys.group}A:active`)).toBe('1');
	});

	test('a stale token frees nothing', async () => {
		await started('a1', 'a2');
		const done = await complete(
			client(),
			keys,
			definition,
			'a1',
			'f'.repeat(32),
			undefined,
			false,
		);
		expect(done.settled).toBe(false);
		expect(await client().get(`${keys.group}A:active`)).toBe('1');
		await expectGroupState(client(), keys, CAP);
	});
});

describe('reclaim', () => {
	const lapse = (id: string) => client().send('ZADD', [keys.active, '0', id]);

	test('frees the slot once, and a late complete frees nothing', async () => {
		const first = await started('a1');
		await lapse('a1');
		const reply = await take();
		expect(reply.stalled).toEqual(['a1']);
		expect(reply.jobs.map((j) => [j.id, j.attempt])).toEqual([['a1', 2]]);
		expect(await client().get(`${keys.group}A:active`)).toBe('1');
		const late = await complete(
			client(),
			keys,
			definition,
			'a1',
			first.token,
			undefined,
			false,
		);
		expect(late.settled).toBe(false);
		expect(await client().get(`${keys.group}A:active`)).toBe('1');
		await expectGroupState(client(), keys, CAP);
	});

	test('a lapse past the last attempt fails the job and frees the slot', async () => {
		await addGrouped(client(), keys, CAP, [
			{ id: 'a1', group: 'A', attempts: 1 },
			{ id: 'a2', group: 'A' },
		]);
		await take();
		await lapse('a1');
		const reply = await take();
		expect(reply.stalled).toEqual(['a1']);
		expect(await client().hget(keys.job('a1'), 'state')).toBe('failed');
		expect(reply.jobs.map((j) => j.id)).toEqual(['a2']);
		expect(await client().get(`${keys.group}A:active`)).toBe('1');
		await expectGroupState(client(), keys, CAP);
	});

	test('a lapse leaves the counters of the other groups sound', async () => {
		await addGrouped(client(), keys, 2, [
			{ id: 'a1', group: 'A' },
			{ id: 'a2', group: 'A' },
			{ id: 'b1', group: 'B' },
		]);
		await claim(client(), keys, 2, 30_000, undefined, { concurrency: 2 });
		await lapse('a1');
		const reply = await claim(client(), keys, 1, 30_000, undefined, {
			concurrency: 2,
		});
		expect(reply.stalled).toEqual(['a1']);
		await expectGroupState(client(), keys, 2);
		expect(await scan(client(), `${keys.group}*:active`)).toContain(
			`${keys.group}A:active`,
		);
	});
});
