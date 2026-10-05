import { describe, expect, test } from 'bun:test';
import {
	bindIdempotency,
	bindRateLimit,
	defineIdempotency,
	defineRateLimit,
	GuardError,
} from '@nxgt/redis';
import * as old from './index';

describe('the deprecated names', () => {
	test('each is the same value as in @nxgt/redis', () => {
		expect(old.defineRateLimit).toBe(defineRateLimit);
		expect(old.bindRateLimit).toBe(bindRateLimit);
		expect(old.defineIdempotency).toBe(defineIdempotency);
		expect(old.bindIdempotency).toBe(bindIdempotency);
		expect(old.GuardError).toBe(GuardError);
	});

	test('exports nothing else', () => {
		expect(Object.keys(old).sort()).toEqual([
			'GuardError',
			'bindIdempotency',
			'bindRateLimit',
			'defineIdempotency',
			'defineRateLimit',
		]);
	});

	test('an error of either name is an instance of both', () => {
		const error = new old.GuardError('RATE_LIMITED', 'login', 'x');
		expect(error).toBeInstanceOf(GuardError);
	});
});
