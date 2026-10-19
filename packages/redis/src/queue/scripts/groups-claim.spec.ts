import { describe, expect, test } from 'bun:test';
import { mailQueue, useClients, useRedis } from '../../../test/fixtures';
import { addGrouped, expectGroupState, scan } from '../../../test/group-state';
import { bindQueue } from '../bind-queue';
import { queueKeys } from '../keys';
import { claim } from './claim';
import { complete, fail } from './settle';

const servers = useRedis();
const clients = useClients(servers);
const keys = queueKeys('mails');
const boom = { name: 'x', message: 'boom' };
const client = () => servers.redis.client;
const job = (group: string, n: number, priority = 0) => ({
	id: `${group.toLowerCase() || 'd'}${n}`,
	group,
	priority,
});
const jobs = (group: string, count: number) =>
	Array.from({ length: count }, (_, i) => job(group, i + 1));
const take = async (n: number, cap = 0) =>
	await claim(client(), keys, n, 30_000, undefined, { concurrency: cap });
const ids = (reply: { jobs: { id: string }[] }) => reply.jobs.map((j) => j.id);
const llen = async (key: string) => Number(await client().send('LLEN', [key]));

describe('grouped claim: round-robin', () => {
	test('serves A, B, C in turn, one claim at a time', async () => {
		await addGrouped(client(), keys, 0, [
			...jobs('A', 3),
			...jobs('B', 3),
			...jobs('C', 3),
		]);
		const order: string[] = [];
		for (let i = 0; i < 9; i += 1) order.push(...ids(await take(1)));
		expect(order).toEqual([
			'a1',
			'b1',
			'c1',
			'a2',
			'b2',
			'c2',
			'a3',
			'b3',
			'c3',
		]);
		await expectGroupState(client(), keys, 0);
	});

	test('inside a group, priority comes first, then arrival', async () => {
		await addGrouped(client(), keys, 0, [
			job('A', 1, 5),
			job('A', 2, 0),
			job('A', 3, 5),
		]);
		expect(ids(await take(3))).toEqual(['a2', 'a1', 'a3']);
		await expectGroupState(client(), keys, 0);
	});

	test('a group with many jobs does not starve a later one', async () => {
		await addGrouped(client(), keys, 0, [...jobs('A', 50), job('B', 1)]);
		expect(ids(await take(4))).toEqual(['a1', 'b1', 'a2', 'a3']);
		await expectGroupState(client(), keys, 0);
	});

	test('a group that joins later goes behind those already waiting', async () => {
		await addGrouped(client(), keys, 0, [...jobs('A', 3), ...jobs('B', 3)]);
		expect(ids(await take(1))).toEqual(['a1']);
		await addGrouped(client(), keys, 0, [job('C', 1)]);
		expect(ids(await take(3))).toEqual(['b1', 'a2', 'c1']);
		await expectGroupState(client(), keys, 0);
	});

	test('the default group takes its turn and has no cap', async () => {
		await addGrouped(client(), keys, 1, [...jobs('', 3), ...jobs('A', 2)]);
		expect(ids(await take(4, 1))).toEqual(['d1', 'a1', 'd2', 'd3']);
		expect(await scan(client(), `${keys.group}:active`)).toEqual([]);
		await expectGroupState(client(), keys, 1);
	});
});

describe('grouped claim: concurrency', () => {
	test('a full group is skipped and the next group is served', async () => {
		await addGrouped(client(), keys, 1, [...jobs('A', 2), job('B', 1)]);
		expect(ids(await take(1, 1))).toEqual(['a1']);
		expect(ids(await take(1, 1))).toEqual(['b1']);
		expect(await client().get(`${keys.group}A:active`)).toBe('1');
		await expectGroupState(client(), keys, 1);
	});

	test('one claim of two takes a job of each group, never two of a full one', async () => {
		await addGrouped(client(), keys, 1, [...jobs('A', 2), job('B', 1)]);
		expect(ids(await take(3, 1)).sort()).toEqual(['a1', 'b1']);
		await expectGroupState(client(), keys, 1);
	});

	test('no spin while every ready job is in a full group', async () => {
		await addGrouped(client(), keys, 1, jobs('A', 2));
		await take(1, 1);
		const reply = await take(1, 1);
		expect(reply.jobs).toEqual([]);
		expect(reply.next).toBe(-1);
		expect(await llen(keys.wake)).toBe(0);
		expect(await llen(keys.groupsReady)).toBe(0);
		await expectGroupState(client(), keys, 1);
	});

	test('a ready job in a free group still leaves the wake token', async () => {
		await addGrouped(client(), keys, 0, jobs('A', 3));
		await take(1);
		expect(await llen(keys.wake)).toBe(1);
		expect(await llen(keys.groupsReady)).toBe(1);
	});

	test('two claimers at once never exceed the cap', async () => {
		const [a, b] = clients();
		await addGrouped(client(), keys, 2, jobs('A', 6));
		const replies = await Promise.all([
			claim(a, keys, 3, 30_000, undefined, { concurrency: 2 }),
			claim(b, keys, 3, 30_000, undefined, { concurrency: 2 }),
		]);
		expect(replies.flatMap(ids)).toHaveLength(2);
		await expectGroupState(client(), keys, 2);
	});
});

describe('grouped claim: stale entries', () => {
	const seed = async (...groups: string[]) => {
		for (const g of groups) {
			await client().send('RPUSH', [keys.groupsReady, g]);
			await client().send('SADD', [keys.groupsQueued, g]);
		}
	};

	test('a group with an empty zset is dropped without looping', async () => {
		await seed('ghost');
		const reply = await take(1);
		expect(reply.jobs).toEqual([]);
		expect(await llen(keys.groupsReady)).toBe(0);
		expect(await llen(keys.wake)).toBe(0);
		await expectGroupState(client(), keys, 0);
	});

	test('a full group in the list is dropped, its job stays ready', async () => {
		await addGrouped(client(), keys, 1, jobs('A', 2));
		await client().send('LPOP', [keys.groupsReady]);
		await client().send('SREM', [keys.groupsQueued, 'A']);
		await client().set(`${keys.group}A:active`, '1');
		await seed('A');
		const reply = await take(1, 1);
		expect(reply.jobs).toEqual([]);
		expect(await llen(keys.groupsReady)).toBe(0);
		expect(await client().send('ZCARD', [keys.ready])).toBe(2);
	});

	test('the takes are capped: 30 stale entries cost three claims', async () => {
		await seed(...Array.from({ length: 30 }, (_, i) => `ghost${i}`));
		await addGrouped(client(), keys, 0, [job('A', 1)]);
		const first = await take(1);
		expect(first.jobs).toEqual([]);
		expect(await llen(keys.groupsReady)).toBe(19);
		expect(await llen(keys.wake)).toBe(1);
		await take(1);
		expect(ids(await take(1))).toEqual(['a1']);
	});
});

describe('an ungrouped queue', () => {
	test('writes no group key through add, claim, complete and fail', async () => {
		const mails = bindQueue(client(), mailQueue);
		for (const id of ['a', 'b', 'c']) await mails.add({ to: id }, { id });
		const reply = await claim(client(), keys, 2, 30_000, undefined);
		const [first, second] = reply.jobs;
		if (!first || !second) throw new Error('two jobs expected');
		await complete(
			client(),
			keys,
			mailQueue,
			first.id,
			first.token,
			undefined,
			true,
		);
		await fail(
			client(),
			keys,
			mailQueue,
			second.id,
			second.token,
			boom,
			10,
			true,
		);
		expect(await scan(client(), `${keys.group.slice(0, -1)}*`)).toEqual([]);
	});
});
