import { describe, expect, test } from 'bun:test';
import { mailQueue, useRedis } from '../../../test/fixtures';
import { bindQueue } from '../bind-queue';
import { queueKeys } from '../keys';
import { claim } from './claim';
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
});
