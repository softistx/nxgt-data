import { describe, expect, test } from 'bun:test';
import { mailQueue, useRedis } from '../../../test/fixtures';
import { bindQueue } from '../bind-queue';
import { queueKeys } from '../keys';
import { claim } from './claim';
import { progress } from './progress';
import { complete } from './settle';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const hget = (id: string, field: string) => client().hget(keys.job(id), field);

async function take(id: string) {
	await bindQueue(client(), mailQueue).add({ to: id }, { id });
	const job = (await claim(client(), keys, 1, 30_000, undefined)).jobs.find(
		(j) => j.id === id,
	);
	if (!job) throw new Error(`${id} was not claimed`);
	return job;
}

describe('progress', () => {
	test('PROGRESS writes only while the token holds', async () => {
		const job = await take('a');
		expect(await progress(client(), keys, 'a', job.token, 40)).toBe(true);
		expect(await hget('a', 'progress')).toBe('40');
		expect(await progress(client(), keys, 'a', '0'.repeat(32), 90)).toBe(false);
		expect(await hget('a', 'progress')).toBe('40');
		expect(await progress(client(), keys, 'ghost', job.token, 10)).toBe(false);
		expect(await client().exists(keys.job('ghost'))).toBe(false);
		await complete(client(), keys, mailQueue, 'a', job.token, undefined, false);
		expect(await progress(client(), keys, 'a', job.token, 95)).toBe(false);
		expect(await hget('a', 'progress')).toBe('40');
	});

	test('PROGRESS keeps a fraction as written', async () => {
		const job = await take('a');
		await progress(client(), keys, 'a', job.token, 12.5);
		expect(await hget('a', 'progress')).toBe('12.5');
	});
});
