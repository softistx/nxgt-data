import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { queueKeys } from '../keys';
import { defineQueue } from './define-queue';

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

test('keeps the result schema, and reads the timeout in milliseconds', () => {
	const result = z.object({ id: z.string() });
	const q = defineQueue({
		name: 'm',
		schema: z.string(),
		result,
		timeout: '2m',
	});
	expect(q.result).toBe(result);
	expect(q.timeout).toBe(120_000);
	const plain = defineQueue({ name: 'm', schema: z.string() });
	expect(plain.result).toBeUndefined();
	expect(plain.timeout).toBeUndefined();
});

test.each([
	[{ name: '' }, /^defineQueue: a queue needs a name/],
	[{ name: 'a{b' }, /^defineQueue: "a\{b" .* braces/],
	[{ name: 'a:b' }, /^defineQueue: "a:b" has a colon; job\.key joins/],
	[{ attempts: 0 }, /^defineQueue: "mails" has attempts of 0; .* at least 1/],
	[
		{ backoff: { base: '1h', max: '1s' } },
		/^defineQueue: "mails" has a backoff base of 3600000ms above its max of 1000ms/,
	],
	[{ lease: 29 }, /^defineQueue: "mails" has a lease of 29ms; .* at least 30/],
	[{ keepCompleted: { count: -1 } }, /keepCompleted count/],
	[{ schema: undefined }, /has no schema/],
	[{ result: 5 }, /^defineQueue: "mails" has a result that is not a schema/],
	[{ timeout: 0 }, /^defineQueue: "mails" has a timeout of 0ms; .* at least 1/],
])('refuses %p', (patch, message) => {
	expect(() =>
		defineQueue({ name: 'mails', schema: z.string(), ...patch } as never),
	).toThrow(message);
});

test('keys share one hash tag', () => {
	const k = queueKeys('app-prod-mails');
	expect(k.ready).toBe('queue:{app-prod-mails}:ready');
	expect(k.job('j1')).toBe('queue:{app-prod-mails}:job:j1');
	expect(k.prefix).toBe('queue:{app-prod-mails}:job:');
	for (const part of [
		'delayed',
		'active',
		'completed',
		'failed',
		'seq',
		'wake',
	]) {
		expect(k[part as 'seq']).toBe(`queue:{app-prod-mails}:${part}`);
	}
});

test('rateLimit is resolved, burst defaults to limit, and freezes', () => {
	const q = defineQueue({
		name: 'm',
		schema: z.string(),
		rateLimit: { limit: 5, per: '1m' },
	});
	expect(q.rateLimit).toEqual({ limit: 5, per: 60_000, burst: 5 });
	expect(Object.isFrozen(q.rateLimit)).toBe(true);
	expect(
		defineQueue({
			name: 'm',
			schema: z.string(),
			rateLimit: { limit: 5, per: 1000, burst: 9 },
		}).rateLimit?.burst,
	).toBe(9);
	expect(
		defineQueue({ name: 'm', schema: z.string() }).rateLimit,
	).toBeUndefined();
});

describe('a rateLimit defineQueue refuses', () => {
	const rate = (rateLimit: unknown) => () =>
		defineQueue({
			name: 'mails',
			schema: z.string(),
			rateLimit: rateLimit as { limit: number; per: number },
		});
	test.each([
		[
			{ limit: 0, per: 1000 },
			'defineQueue: "mails" rateLimit has a limit of 0; it is a whole number of requests, and must be at least 1',
		],
		[
			{ limit: 1, per: '0s' },
			'defineQueue: "mails" rateLimit has a per of 0; it is a whole number of milliseconds, and must be at least 1',
		],
		[
			{ limit: 1, per: 1000, burst: 1.5 },
			'defineQueue: "mails" rateLimit has a burst of 1.5; it is a whole number of requests, and must be at least 1',
		],
		[
			{ limit: 1, per: 9_007_199_254_740, burst: 2 },
			'defineQueue: "mails" rateLimit has a burst of 2 and a per of 9007199254740ms; burst × per must be at most 9007199254740 for the script to count exactly',
		],
		[
			{ limit: 1, per: 'soon' },
			'defineQueue: "mails" rateLimit per is "soon"; a duration is a whole number of milliseconds or a string such as \'10m\'',
		],
		[
			{ per: 1000 },
			'defineQueue: "mails" rateLimit has a limit of undefined; it is a whole number of requests, and must be at least 1',
		],
	])('%j', (value, message) => {
		expect(rate(value)).toThrow(message);
	});

	test('a rateLimit that is not an object', () => {
		expect(rate(5)).toThrow(
			'defineQueue: "mails" has a rateLimit that is not an object; it is { limit, per, burst? }',
		);
	});
});
