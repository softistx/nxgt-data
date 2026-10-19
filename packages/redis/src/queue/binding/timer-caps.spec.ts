import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { gate, mailQueue, subscribed, useRedis } from '../../../test/fixtures';
import { rejection } from '../../../test/rejection';
import type { QueueError } from '../../errors/queue-error';
import { bindQueue } from './bind-queue';
import { queueKeys } from './keys';

const servers = useRedis();
const client = () => servers.redis.client;
const keys = queueKeys('mails');

/** The longest a timer waits; one longer fires at once. */
const CAP = 2_147_483_647;

/** The delays every `setTimeout` was given while the spy was on. */
function timerDelays() {
	const delays: number[] = [];
	const real = globalThis.setTimeout;
	const spy = spyOn(globalThis, 'setTimeout').mockImplementation(((
		fn: () => void,
		ms?: number,
		...rest: unknown[]
	) => {
		delays.push(ms ?? 0);
		return real(fn, ms, ...rest);
	}) as typeof setTimeout);
	return { delays, restore: () => spy.mockRestore() };
}

afterEach(() => {
	// A spy left on by a failed assertion must not reach the next test.
	(
		globalThis.setTimeout as unknown as { mockRestore?: () => void }
	).mockRestore?.();
});

describe('a wait longer than a timer can hold', () => {
	test('finished({ timeout }) above the cap waits, and ends by the outcome', async () => {
		const queue = bindQueue(client(), mailQueue);
		const handle = await queue.add({ to: 'a' }, { id: 'a' });
		const timers = timerDelays();
		const waited = rejection(handle.finished({ timeout: CAP + 1 }));
		await subscribed(client(), keys.events);
		timers.restore();
		expect(timers.delays).toContain(CAP);
		expect(timers.delays.every((ms) => ms <= CAP)).toBe(true);
		expect(await queue.cancel('a')).toBe(true);
		expect(((await waited) as QueueError).code).toBe('CANCELED');
	});

	test('close({ grace }) above the cap is armed at the cap', async () => {
		const release = gate();
		const started = gate();
		const queue = bindQueue(client(), mailQueue);
		const worker = queue.work(async () => {
			started.open();
			await release.opened;
		});
		await queue.add({ to: 'a' }, { id: 'a' });
		await started.opened;
		const timers = timerDelays();
		const closing = worker.close({ grace: CAP + 1 });
		timers.restore();
		release.open();
		await closing;
		expect(timers.delays).toContain(CAP);
		expect(timers.delays.every((ms) => ms <= CAP)).toBe(true);
	});
});
