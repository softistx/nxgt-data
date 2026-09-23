import { describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { exportLimit, loginLimit } from '../../test/fixtures';
import { bindRateLimit } from './bind-rate-limit';
import { defineRateLimit } from './define-rate-limit';
import type { RateLimitDefinition } from './types';

// No server: every refusal here happens before a command could be sent.

const base = {
	name: 'login',
	key: (params: { ip: string }) => params.ip,
	limit: 5,
	per: 60_000,
};

describe('defineRateLimit', () => {
	test('refuses a limit with no name, which would key on nothing', () => {
		expect(() => defineRateLimit({ ...base, name: '' })).toThrow(
			new TypeError('defineRateLimit: a rate limit needs a name, for its keys'),
		);
	});

	test('refuses a key that is not a function', () => {
		const key = 'ip' as unknown as (params: { ip: string }) => string;
		expect(() => defineRateLimit({ ...base, key })).toThrow(
			'defineRateLimit: "login" has no key function',
		);
	});

	test('refuses a limit that is not a whole number of at least 1', () => {
		for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => defineRateLimit({ ...base, limit })).toThrow(
				`defineRateLimit: "login" has a limit of ${limit}; it is a whole number of requests, and must be at least 1`,
			);
		}
	});

	test('refuses a per that is not a whole number of milliseconds', () => {
		for (const per of [0, -60, 0.5, Number.NaN]) {
			expect(() => defineRateLimit({ ...base, per })).toThrow(
				`defineRateLimit: "login" has a per of ${per}; it is a whole number of milliseconds, and must be at least 1`,
			);
		}
	});

	test('refuses a burst that is not a whole number of at least 1', () => {
		for (const burst of [0, 2.5]) {
			expect(() => defineRateLimit({ ...base, burst })).toThrow(
				`defineRateLimit: "login" has a burst of ${burst}; it is a whole number of requests`,
			);
		}
	});

	test('refuses a rate that would take years to refill, which is a unit mistake', () => {
		// One a minute, written as if `per` were in microseconds.
		expect(() =>
			defineRateLimit({ ...base, limit: 1, per: 60e9, burst: 10 }),
		).toThrow('would take longer than ten years to refill from empty');
		// The same bucket in milliseconds is fine.
		expect(() =>
			defineRateLimit({ ...base, limit: 1, per: 60_000, burst: 10 }),
		).not.toThrow();
	});

	test('a refusal is a bare TypeError, not a GuardError', () => {
		let caught: unknown;
		try {
			defineRateLimit({ ...base, limit: 0 });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(TypeError);
		expect((caught as Error).constructor).toBe(TypeError);
	});

	test('is frozen, so a definition cannot drift after it is shared', () => {
		expect(Object.isFrozen(loginLimit)).toBe(true);
	});

	test('keeps the burst it was given, and leaves it out when none was', () => {
		expect(exportLimit.burst).toBe(20);
		expect(loginLimit.burst).toBeUndefined();
	});
});

describe('bindRateLimit', () => {
	const client = new RedisClient('redis://127.0.0.1:1', {
		autoReconnect: false,
	});

	test('keys under the definition’s name, as a cache does', () => {
		expect(bindRateLimit(client, loginLimit).keyFor({ ip: '10.0.0.1' })).toBe(
			'login:10.0.0.1',
		);
		expect(
			bindRateLimit(client, exportLimit).keyFor({ org: 'acme', user: 'u1' }),
		).toBe('export:acme/u1');
	});

	test('checks a definition written by hand, and names itself', () => {
		const handWritten: RateLimitDefinition<string> = {
			name: 'raw',
			key: (id) => id,
			limit: 5,
			per: 0,
		};
		expect(() => bindRateLimit(client, handWritten)).toThrow(
			'bindRateLimit: "raw" has a per of 0',
		);
	});
});
