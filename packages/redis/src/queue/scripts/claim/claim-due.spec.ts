import { describe, expect, test } from 'bun:test';
import { mailQueue, useRedis } from '../../../../test/fixtures';
import { bindQueue } from '../../binding/bind-queue';
import { queueKeys } from '../../binding/keys';
import { complete, fail } from '../settle';
import { claim } from './claim';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const send = (...args: string[]) => client().send(args[0] ?? '', args.slice(1));
const DATA = '{"to":"a@b.c"}';

async function schedule(id: string, next: number, fields: string[]) {
	await send('HSET', `${keys.schedule}${id}`, ...fields);
	await send('ZADD', keys.schedules, String(next), id);
}
const cron = (id: string, next: number) =>
	schedule(id, next, [
		'kind',
		'cron',
		'spec',
		'* * * * *',
		'timezone',
		'Europe/Paris',
		'data',
		DATA,
		'origin',
		'runtime',
	]);
const every = (id: string, next: number) =>
	schedule(id, next, [
		'kind',
		'every',
		'spec',
		'60000',
		'data',
		DATA,
		'origin',
		'definition',
	]);

describe('claim reports due schedules', () => {
	test('lists those due, with kind, spec, timezone and score, and not the future ones', async () => {
		await cron('c', 1000);
		await every('e', 2000);
		await every('later', Date.now() + 3_600_000);
		const reply = await claim(client(), keys, 5, 30_000, undefined);
		expect(reply.due).toEqual([
			{
				id: 'c',
				kind: 'cron',
				spec: '* * * * *',
				timezone: 'Europe/Paris',
				due: 1000,
			},
			{ id: 'e', kind: 'every', spec: '60000', timezone: '', due: 2000 },
		]);
		// Reporting changes nothing: the client fires.
		expect(await send('ZSCORE', keys.schedules, 'c')).toBe(1000);
	});

	test('reports at most 20, the earliest first', async () => {
		for (let i = 0; i < 25; i += 1) await every(`s${i}`, 1000 + i);
		const reply = await claim(client(), keys, 5, 30_000, undefined);
		expect(reply.due).toHaveLength(20);
		expect(reply.due[0]?.id).toBe('s0');
		expect(reply.due[19]?.id).toBe('s19');
	});

	test('reports them while the queue is paused', async () => {
		await every('e', 1000);
		await send('SET', keys.paused, '1');
		const reply = await claim(client(), keys, 5, 30_000, undefined);
		expect(reply.due.map((d) => d.id)).toEqual(['e']);
	});

	test('complete and fail carry the due list too', async () => {
		const mails = bindQueue(client(), mailQueue);
		await mails.add({ to: 'x' }, { id: 'x' });
		await mails.add({ to: 'y' }, { id: 'y' });
		const first = await claim(client(), keys, 1, 30_000, undefined);
		await every('e', 1000);
		const done = await complete(
			client(),
			keys,
			mailQueue,
			'x',
			first.jobs[0]?.token ?? '',
			undefined,
			true,
		);
		expect(done.due.map((d) => d.id)).toEqual(['e']);
		const second = done.jobs[0];
		const failed = await fail(
			client(),
			keys,
			mailQueue,
			'y',
			second?.token ?? '',
			{ name: 'E', message: 'm' },
			null,
			true,
		);
		expect(failed.due.map((d) => d.id)).toEqual(['e']);
		const bare = await complete(
			client(),
			keys,
			mailQueue,
			'nope',
			'x',
			undefined,
			false,
		);
		expect(bare.due).toEqual([]);
	});

	test('next is the schedules head when sooner than the delayed head', async () => {
		const now = Date.now();
		await bindQueue(client(), mailQueue).add(
			{ to: 'x' },
			{ id: 'x', delay: '1h' },
		);
		await every('soon', now + 30_000);
		const soon = await claim(client(), keys, 5, 30_000, undefined);
		expect(soon.next).toBeGreaterThan(20_000);
		expect(soon.next).toBeLessThanOrEqual(30_000);
		await send('DEL', keys.schedules);
		const delayedOnly = await claim(client(), keys, 5, 30_000, undefined);
		expect(delayedOnly.next).toBeGreaterThan(3_000_000);
	});

	test('a due schedule nobody fires never makes next 0', async () => {
		await every('due', Date.now() - 5);
		const alone = await claim(client(), keys, 5, 30_000, undefined);
		expect(alone.due.map((d) => d.id)).toEqual(['due']);
		expect(alone.next).toBe(-1);
		await every('later', Date.now() + 30_000);
		const again = await claim(client(), keys, 5, 30_000, undefined);
		expect(again.due.map((d) => d.id)).toEqual(['due']);
		expect(again.next).toBeGreaterThan(20_000);
		expect(again.next).toBeLessThanOrEqual(30_000);
	});

	test('a full page of 20 due schedules gives next 0, so a backlog drains', async () => {
		for (let i = 0; i < 20; i += 1) await every(`s${i}`, 1000 + i);
		await every('later', Date.now() + 30_000);
		const reply = await claim(client(), keys, 5, 30_000, undefined);
		expect(reply.due).toHaveLength(20);
		expect(reply.next).toBe(0);
	});

	test('25 unsound hashes at the head do not hide a sound schedule behind them', async () => {
		for (let i = 0; i < 25; i += 1) {
			await schedule(`bad${i}`, 1000 + i, [
				'kind',
				'weekly',
				'spec',
				'1',
				'data',
				DATA,
				'origin',
				'runtime',
			]);
		}
		await every('good', 5000);
		const reply = await claim(client(), keys, 5, 30_000, undefined);
		expect(reply.due.map((d) => d.id)).toEqual(['good']);
	});

	test('the delayed head wins when it is sooner', async () => {
		await bindQueue(client(), mailQueue).add(
			{ to: 'x' },
			{ id: 'x', delay: '10s' },
		);
		await every('far', Date.now() + 3_600_000);
		const reply = await claim(client(), keys, 5, 30_000, undefined);
		expect(reply.next).toBeLessThanOrEqual(10_000);
		expect(reply.next).toBeGreaterThan(5_000);
	});
});

describe('claim skips a schedule hash it could not have written', () => {
	test.each([
		['without kind', ['spec', '1', 'data', DATA, 'origin', 'runtime']],
		['without spec', ['kind', 'cron', 'data', DATA, 'origin', 'runtime']],
		[
			'without data',
			['kind', 'cron', 'spec', '* * * * *', 'origin', 'runtime'],
		],
		['without origin', ['kind', 'cron', 'spec', '* * * * *', 'data', DATA]],
		[
			'of an unknown kind',
			['kind', 'weekly', 'spec', '1', 'data', DATA, 'origin', 'runtime'],
		],
		[
			'with a timezone on an every',
			[
				'kind',
				'every',
				'spec',
				'60000',
				'timezone',
				'UTC',
				'data',
				DATA,
				'origin',
				'runtime',
			],
		],
	])('a hash %s', async (_name, fields) => {
		await schedule('bad', 1000, fields);
		await every('good', 2000);
		const reply = await claim(client(), keys, 5, 30_000, undefined);
		expect(reply.due.map((d) => d.id)).toEqual(['good']);
		// Never repaired, and it does not make the next wait spin at zero.
		expect(await send('ZSCORE', keys.schedules, 'bad')).toBe(1000);
		expect(await send('HLEN', `${keys.schedule}bad`)).toBe(fields.length / 2);
	});

	test('an unsound due schedule alone leaves next at the cap, not 0', async () => {
		await schedule('bad', 1000, [
			'kind',
			'weekly',
			'spec',
			'1',
			'data',
			DATA,
			'origin',
			'runtime',
		]);
		const reply = await claim(client(), keys, 5, 30_000, undefined);
		expect(reply.due).toEqual([]);
		expect(reply.next).toBe(-1);
	});
});
