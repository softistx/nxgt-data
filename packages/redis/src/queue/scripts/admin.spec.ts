import { describe, expect, test } from 'bun:test';
import { mailQueue, useRedis } from '../../../test/fixtures';
import { runScript } from '../../scripts/run-script';
import { bindQueue } from '../bind-queue';
import { queueKeys } from '../keys';
import { RETRY } from './admin';
import { claim, scriptKeys } from './claim';
import { fail } from './settle';
import { stepCommit } from './step';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;

describe('RETRY', () => {
	test('RETRY keeps step fields', async () => {
		const mails = bindQueue(client(), mailQueue);
		await mails.add({ to: 'a' }, { id: 'a' });
		const [job] = (await claim(client(), keys, 1, 30_000)).jobs;
		if (!job) throw new Error('not claimed');
		await stepCommit(client(), keys, 'a', job.token, 'one', '{"n":1}');
		await stepCommit(client(), keys, 'a', job.token, 'two', '');
		await fail(
			client(),
			keys,
			mailQueue,
			'a',
			job.token,
			{ name: 'B', message: 'b' },
			null,
			false,
		);
		await mails.retry('a');
		expect(await client().hget(keys.job('a'), 'state')).toBe('waiting');
		expect(await client().hget(keys.job('a'), 'step:one')).toBe('{"n":1}');
		expect(await client().hget(keys.job('a'), 'step:two')).toBe('');
	});
	/** A failed job `a` holding two step fields, one named as a prefix of the other. */
	async function failedWithSteps(data = { to: 'step:x' }) {
		const mails = bindQueue(client(), mailQueue);
		await mails.add(data, { id: 'a', priority: 7 });
		const [job] = (await claim(client(), keys, 1, 30_000)).jobs;
		if (!job) throw new Error('not claimed');
		await stepCommit(client(), keys, 'a', job.token, 'a', '1');
		await stepCommit(client(), keys, 'a', job.token, 'ab', '2');
		await fail(
			client(),
			keys,
			mailQueue,
			'a',
			job.token,
			{ name: 'B', message: 'b' },
			null,
			false,
		);
		return mails;
	}
	const retryScript = (fresh: string) =>
		runScript(client(), RETRY, scriptKeys(keys), [keys.prefix, 'a', fresh]);

	test('RETRY with fresh clears every step field and keeps data, priority and attempts', async () => {
		await failedWithSteps();
		const before = await client().hgetall(keys.job('a'));
		expect(await retryScript('1')).toBe(1);
		const after = await client().hgetall(keys.job('a'));
		expect(Object.keys(after).filter((f) => f.startsWith('step:'))).toEqual([]);
		expect(after.data).toBe(before.data);
		expect(after.data).toContain('step:x');
		expect(after.priority).toBe(before.priority);
		expect(after.attempts).toBe(before.attempts);
		expect(after.state).toBe('waiting');
		expect(after.attempt).toBe('0');
	});

	test('RETRY without fresh keeps step fields', async () => {
		await failedWithSteps();
		expect(await retryScript('0')).toBe(1);
		expect(await client().hget(keys.job('a'), 'step:a')).toBe('1');
		expect(await client().hget(keys.job('a'), 'step:ab')).toBe('2');
	});

	test('RETRY with fresh on a job that is not failed changes nothing, steps included', async () => {
		const mails = bindQueue(client(), mailQueue);
		await mails.add({ to: 'a' }, { id: 'a' });
		await client().hset(keys.job('a'), 'step:a', '1');
		const before = await client().hgetall(keys.job('a'));
		expect(await retryScript('1')).toBe(0);
		expect(await client().hgetall(keys.job('a'))).toEqual(before);
	});
});
