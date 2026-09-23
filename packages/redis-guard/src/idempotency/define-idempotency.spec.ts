import { describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { z } from 'zod';
import { createOrder } from '../../test/fixtures';
import { bindIdempotency } from './bind-idempotency';
import { defineIdempotency } from './define-idempotency';
import type { IdempotencyDefinition } from './types';

// The refusals: a definition that could never work is a bare TypeError, at
// import. No server — nothing here is sent.

const base = {
	name: 'x',
	key: (id: string) => id,
	ttl: 60,
	schema: z.string(),
};

describe('defineIdempotency', () => {
	test('refuses an empty name, which would key on nothing', () => {
		expect(() => defineIdempotency({ ...base, name: '' })).toThrow(
			'defineIdempotency: an idempotent operation needs a name, for its keys',
		);
	});

	test('refuses a key that is not a function', () => {
		const key = 'fixed' as unknown as (id: string) => string;
		expect(() => defineIdempotency({ ...base, key })).toThrow(
			'defineIdempotency: "x" has no key function; it builds the rest of the key from the params',
		);
	});

	test('refuses a ttl that is not a whole number of seconds of at least 1', () => {
		for (const ttl of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => defineIdempotency({ ...base, ttl })).toThrow(
				`defineIdempotency: "x" has a ttl of ${ttl}; it is a whole number of seconds, and must be at least 1`,
			);
		}
	});

	test('refuses a lease that is not a whole number of milliseconds of at least 1', () => {
		for (const lease of [0, -5, 0.5, Number.NaN]) {
			expect(() => defineIdempotency({ ...base, lease })).toThrow(
				`defineIdempotency: "x" has a lease of ${lease}; it is a whole number of milliseconds, and must be at least 1`,
			);
		}
	});

	test('refuses a definition without a schema', () => {
		const schema = undefined as unknown as z.ZodString;
		expect(() => defineIdempotency({ ...base, schema })).toThrow(
			'defineIdempotency: "x" has no schema; a stored result is checked against one both ways',
		);
	});

	test('is frozen, so a definition cannot drift after it is shared', () => {
		expect(Object.isFrozen(createOrder)).toBe(true);
	});
});

describe('bindIdempotency', () => {
	test('checks a definition written by hand, naming itself', () => {
		const client = new RedisClient('redis://127.0.0.1:1');
		const byHand: IdempotencyDefinition<string, z.ZodString> = {
			...base,
			ttl: 0,
		};
		expect(() => bindIdempotency(client, byHand)).toThrow(
			'bindIdempotency: "x" has a ttl of 0;',
		);
		client.close();
	});

	test('keys under the definition’s name, as a cache and a limit do', () => {
		const client = new RedisClient('redis://127.0.0.1:1');
		const orders = bindIdempotency(client, createOrder);
		expect(orders.keyFor({ user: 'u1', key: 'k1' })).toBe(
			'orders.create:u1/k1',
		);
		client.close();
	});
});
