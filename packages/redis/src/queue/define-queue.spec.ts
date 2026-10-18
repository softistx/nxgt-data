import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineQueue } from './define-queue';
import { queueKeys } from './keys';

test('fills the defaults, in milliseconds, and freezes', () => {
	const q = defineQueue({
		name: 'mails',
		schema: z.object({ to: z.string() }),
	});
	expect(q).toMatchObject({
		attempts: 3,
		backoff: { base: 1_000, max: 3_600_000 },
		lease: 30_000,
		keepCompleted: { age: 3_600_000, count: 1000 },
		keepFailed: 604_800_000,
	});
	expect(Object.isFrozen(q)).toBe(true);
});

test('takes durations as strings', () => {
	const q = defineQueue({
		name: 'm',
		schema: z.string(),
		lease: '1m',
		backoff: { base: '2s' },
		keepFailed: '1d',
	});
	expect([q.lease, q.backoff.base, q.backoff.max, q.keepFailed]).toEqual([
		60_000, 2_000, 3_600_000, 86_400_000,
	]);
});

test('keepCompleted: false keeps nothing, and a half-set one is filled', () => {
	expect(
		defineQueue({ name: 'm', schema: z.string(), keepCompleted: false })
			.keepCompleted,
	).toBe(false);
	expect(
		defineQueue({ name: 'm', schema: z.string(), keepCompleted: { count: 5 } })
			.keepCompleted,
	).toEqual({ age: 3_600_000, count: 5 });
});

test.each([
	[{ name: '' }, /^defineQueue: a queue needs a name/],
	[{ name: 'a{b' }, /^defineQueue: "a\{b" .* braces/],
	[{ attempts: 0 }, /^defineQueue: "mails" has attempts of 0; .* at least 1/],
	[
		{ backoff: { base: '1h', max: '1s' } },
		/^defineQueue: "mails" has a backoff base of 3600000ms above its max of 1000ms/,
	],
	[{ lease: 29 }, /^defineQueue: "mails" has a lease of 29ms; .* at least 30/],
	[{ keepCompleted: { count: -1 } }, /keepCompleted count/],
	[{ schema: undefined }, /has no schema/],
])('refuses %p', (patch, message) => {
	expect(() =>
		defineQueue({ name: 'mails', schema: z.string(), ...patch } as never),
	).toThrow(message);
});

test('keys share one hash tag', () => {
	const k = queueKeys('app:prod:mails');
	expect(k.ready).toBe('queue:{app:prod:mails}:ready');
	expect(k.job('j1')).toBe('queue:{app:prod:mails}:job:j1');
	expect(k.prefix).toBe('queue:{app:prod:mails}:job:');
	for (const part of [
		'delayed',
		'active',
		'completed',
		'failed',
		'seq',
		'wake',
	]) {
		expect(k[part as 'seq']).toBe(`queue:{app:prod:mails}:${part}`);
	}
});
