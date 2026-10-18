import { describe, expect, test } from 'bun:test';
import { JobError } from './job-error';

describe('JobError', () => {
	test('retries as the backoff says by default', () => {
		const error = new JobError('x');
		expect(error.retry).toBe(true);
		expect(error.retryIn).toBeUndefined();
	});

	test('retry: false gives up; retryIn chooses a delay', () => {
		expect(new JobError('x', { retry: false }).retry).toBe(false);
		const error = new JobError('x', { retryIn: '1s' });
		expect(error.retry).toBe(true);
		expect(error.retryIn).toBe(1000);
	});

	test('an undefined option means not given, as without exactOptionalPropertyTypes', () => {
		const delayed = new JobError('x', {
			retryIn: '1s',
			retry: undefined,
		} as never);
		expect(delayed.retry).toBe(true);
		expect(delayed.retryIn).toBe(1000);
		const gaveUp = new JobError('x', {
			retry: false,
			retryIn: undefined,
		} as never);
		expect(gaveUp.retry).toBe(false);
		expect(gaveUp.retryIn).toBeUndefined();
	});
});
