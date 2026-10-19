import { afterEach, describe, expect, test } from 'bun:test';
import {
	blocked,
	eventually,
	gate,
	mailQueue,
	scriptCalls,
	useRedis,
} from '../../../test/fixtures';
import { bindQueue } from '../bind-queue';
import { queueKeys } from '../keys';
import { claim } from '../scripts/claim';
import type { Worker } from './types';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const mails = () => bindQueue(client(), mailQueue);
const state = (id: string) => client().hget(keys.job(id), 'state');

const opened: Worker[] = [];
afterEach(async () => {
	for (const worker of opened.splice(0)) await worker.close();
});
function work(...args: Parameters<ReturnType<typeof mails>['work']>) {
	const worker = mails().work(...args);
	opened.push(worker);
	return worker;
}

describe('a paused queue', () => {
	test('does not spin', async () => {
		const queue = mails();
		await queue.pause();
		await queue.add({ to: 'a' }, { id: 'a' });
		// Loads CLAIM in the server's cache: a cold EVALSHA costs two calls.
		await claim(client(), keys, 1, 30_000);
		const before = await scriptCalls(client());
		work(() => ({ messageId: 'x' }));
		work(() => ({ messageId: 'x' }));
		await Bun.sleep(2_000);
		// One claim per worker, then each blocks until its 5 s cap.
		expect((await scriptCalls(client())) - before).toBeLessThanOrEqual(2);
		expect(await state('a')).toBe('waiting');
	});

	test('resume wakes a blocked worker within 500 ms', async () => {
		const queue = mails();
		await queue.pause();
		await queue.add({ to: 'a' }, { id: 'a' });
		const started = gate();
		work(() => {
			started.open();
			return { messageId: 'x' };
		});
		await blocked(client());
		await queue.resume();
		const late = Bun.sleep(500).then(() => 'late');
		expect(await Promise.race([started.opened.then(() => 'ran'), late])).toBe(
			'ran',
		);
	});

	test('resume wakes a blocked worker for a delayed job that fell due during the pause', async () => {
		const queue = mails();
		await queue.pause();
		await queue.add({ to: 'a' }, { id: 'a', delay: 50 });
		const started = gate();
		work(() => {
			started.open();
			return { messageId: 'x' };
		});
		await blocked(client());
		// Past its time, yet nothing promoted it: the worker is blocked.
		await Bun.sleep(100);
		await queue.resume();
		const late = Bun.sleep(500).then(() => 'late');
		expect(await Promise.race([started.opened.then(() => 'ran'), late])).toBe(
			'ran',
		);
	});

	test('pause lets a running job finish', async () => {
		const queue = mails();
		const started = gate();
		const release = gate();
		work(async () => {
			started.open();
			await release.opened;
			return { messageId: 'x' };
		});
		await queue.add({ to: 'a' }, { id: 'a' });
		await started.opened;
		await queue.add({ to: 'b' }, { id: 'b' });
		await queue.pause();
		release.open();
		await eventually(() => state('a'), 'completed');
		expect(await state('b')).toBe('waiting');
	});
});
