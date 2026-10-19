import { describe, expect, test } from 'bun:test';
import { eventually, mailQueue, useRedis } from '../../../test/fixtures';
import { QueueError } from '../../errors/queue-error';
import { bindQueue } from '../binding/bind-queue';
import { queueKeys } from '../binding/keys';
import { claim } from '../scripts/claim/claim';
import { complete, fail } from '../scripts/settle';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const mails = () => bindQueue(client(), mailQueue);
const send = (...args: string[]) => client().send(args[0] ?? '', args.slice(1));
const to = (address: string) => ({ to: address });
const boom = { name: 'Boom', message: 'it broke' };

/** Takes one job and fails it for good (no retry delay), leaving it in `failed`. */
async function failed(id: string) {
	await mails().add(to(id), { id });
	const [job] = (await claim(client(), keys, 1, 30_000, undefined)).jobs;
	if (!job || job.id !== id) throw new Error(`${id} was not claimed`);
	await fail(client(), keys, mailQueue, id, job.token, boom, null, false);
}

async function refused(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('expected a refusal');
}

describe('counts', () => {
	test('counts every state in one script', async () => {
		const q = mails();
		// The claims come first: a claim takes the oldest waiting job.
		await failed('f');
		await q.add(to('c'), { id: 'c' });
		const [job] = (await claim(client(), keys, 1, 30_000, undefined)).jobs;
		if (!job) throw new Error('nothing claimed');
		await complete(
			client(),
			keys,
			mailQueue,
			job.id,
			job.token,
			undefined,
			false,
		);
		await q.add(to('a'), { id: 'a' });
		await claim(client(), keys, 1, 30_000, undefined);
		await q.add(to('w'), { id: 'w' });
		await q.add(to('d'), { id: 'd', delay: '1h' });
		const before = Number(
			(await client().info('commandstats')).match(
				/cmdstat_evalsha:calls=(\d+)/,
			)?.[1] ?? 0,
		);
		const counts = await q.counts();
		const after = Number(
			(await client().info('commandstats')).match(
				/cmdstat_evalsha:calls=(\d+)/,
			)?.[1] ?? 0,
		);
		expect(counts).toEqual({
			waiting: 1,
			delayed: 1,
			active: 1,
			completed: 1,
			failed: 1,
			paused: false,
		});
		expect(after - before).toBe(1);
	});
});

describe('get', () => {
	test('get maps the hash, with data parsed and dates as Date', async () => {
		await failed('f');
		await mails().add(to('w'), { id: 'w', priority: 7 });
		const view = await mails().get('f');
		expect(view).toMatchObject({
			id: 'f',
			state: 'failed',
			data: { to: 'f', template: 'welcome' },
			attempt: 1,
			attempts: 3,
			priority: 0,
			error: boom,
		});
		expect(view?.added).toBeInstanceOf(Date);
		expect(view?.runAt).toBeInstanceOf(Date);
		expect(view?.finished).toBeInstanceOf(Date);
		const waiting = await mails().get('w');
		expect(waiting?.priority).toBe(7);
		expect(waiting?.error).toBeUndefined();
		expect(waiting?.finished).toBeUndefined();
		expect(await mails().get('ghost')).toBeUndefined();
	});

	test('get gives data undefined when the stored data no longer parses', async () => {
		await mails().add(to('a'), { id: 'a' });
		await send('HSET', keys.job('a'), 'data', '{"to":5}');
		const view = await mails().get('a');
		expect(view?.data).toBeUndefined();
		expect(view?.state).toBe('waiting');
		await send('HSET', keys.job('a'), 'data', 'not json');
		expect((await mails().get('a'))?.data).toBeUndefined();
	});
});

describe('list', () => {
	test('list pages each state in its order and skips vanished hashes', async () => {
		const q = mails();
		await failed('f1');
		await Bun.sleep(5);
		await failed('f2');
		for (const id of ['w1', 'w2', 'w3']) await q.add(to(id), { id });
		await q.add(to('d1'), { id: 'd1', delay: '2h' });
		await q.add(to('d2'), { id: 'd2', delay: '1h' });
		const ids = async (state: Parameters<typeof q.list>[0], page?: object) =>
			(await q.list(state, page)).map((job) => job.id);
		expect(await ids('waiting')).toEqual(['w1', 'w2', 'w3']);
		expect(await ids('waiting', { offset: 1, limit: 1 })).toEqual(['w2']);
		expect(await ids('delayed')).toEqual(['d2', 'd1']);
		expect(await ids('active')).toEqual([]);
		await claim(client(), keys, 1, 30_000, undefined);
		expect(await ids('active')).toEqual(['w1']);

		// newest first for finished jobs
		expect(await ids('failed')).toEqual(['f2', 'f1']);
		expect(await ids('failed', { offset: 1 })).toEqual(['f1']);

		// a hash that vanished is skipped; the page is shorter, not broken
		await send('DEL', keys.job('w2'));
		expect(await ids('waiting')).toEqual(['w3']);
	});

	test('limit above 1000 is refused', async () => {
		const q = mails();
		const limit = 'list on "mails": limit is a whole number from 1 to 1000';
		for (const bad of [1001, 0]) {
			const error = await refused(q.list('waiting', { limit: bad }));
			expect(error).toBeInstanceOf(TypeError);
			expect((error as Error).message).toBe(limit);
		}
		const offset = await refused(q.list('waiting', { offset: -1 }));
		expect(offset).toBeInstanceOf(TypeError);
		expect((offset as Error).message).toBe(
			'list on "mails": offset is a whole number from 0',
		);
		const state = await refused(q.list('done' as never));
		expect((state as Error).message).toBe(
			'list on "mails": state is one of waiting, delayed, active, completed, failed',
		);
		expect(await q.list('waiting', { limit: 1000 })).toEqual([]);
	});
});

describe('retry', () => {
	test('retry puts a failed job back with its attempts reset, and a worker runs it', async () => {
		await failed('f');
		await mails().retry('f');
		const view = await mails().get('f');
		expect(view).toMatchObject({ state: 'waiting', attempt: 0 });
		expect(view?.error).toBeUndefined();
		expect(view?.finished).toBeUndefined();
		expect(await send('ZSCORE', keys.failed, 'f')).toBeNull();
		expect(await send('LLEN', keys.wake)).toBe(1);

		const seen: number[] = [];
		const worker = mails().work((job) => void seen.push(job.attempt));
		try {
			await eventually(
				async () => (await mails().get('f'))?.state,
				'completed',
			);
			expect(seen).toEqual([1]);
		} finally {
			await worker.close();
		}
	});

	test('retry of a job not failed is NOT_FOUND', async () => {
		await mails().add(to('w'), { id: 'w' });
		for (const id of ['w', 'ghost']) {
			const error = await refused(mails().retry(id));
			expect(error).toBeInstanceOf(QueueError);
			expect(error).toMatchObject({
				code: 'NOT_FOUND',
				queue: 'mails',
				job: id,
			});
			expect((error as Error).message).toContain(id);
		}
		expect((await mails().get('w'))?.state).toBe('waiting');
	});
});

describe('remove', () => {
	test('remove deletes a waiting, delayed, completed or failed job; refuses an active one with ACTIVE', async () => {
		const q = mails();
		await failed('f');
		await q.add(to('c'), { id: 'c' });
		const [job] = (await claim(client(), keys, 1, 30_000, undefined)).jobs;
		if (!job) throw new Error('nothing claimed');
		await complete(
			client(),
			keys,
			mailQueue,
			job.id,
			job.token,
			undefined,
			false,
		);
		await q.add(to('a'), { id: 'a' });
		await claim(client(), keys, 1, 30_000, undefined);
		await q.add(to('w'), { id: 'w' });
		await q.add(to('d'), { id: 'd', delay: '1h' });
		const owner = (await q.list('active'))[0]?.id;
		expect(owner).toBeDefined();

		for (const id of ['d', 'f', job.id]) await q.remove(id);
		expect(await q.counts()).toEqual({
			waiting: 1,
			delayed: 0,
			active: 1,
			completed: 0,
			failed: 0,
			paused: false,
		});
		expect(await q.get('d')).toBeUndefined();
		await q.remove('w');

		const active = await refused(q.remove(owner ?? ''));
		expect(active).toMatchObject({
			code: 'ACTIVE',
			queue: 'mails',
			job: owner,
		});
		expect((await q.get(owner ?? ''))?.state).toBe('active');

		const absent = await refused(q.remove('ghost'));
		expect(absent).toMatchObject({ code: 'NOT_FOUND', job: 'ghost' });
	});
});
