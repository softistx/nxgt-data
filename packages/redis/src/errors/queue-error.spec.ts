import { expect, test } from 'bun:test';
import { JobError } from './job-error';
import { QueueError } from './queue-error';

test('JobError carries retry and retryIn', () => {
	expect(new JobError('x').retry).toBe(true);
	expect(new JobError('x', { retry: false }).retry).toBe(false);
	expect(new JobError('x', { retryIn: '10m' }).retryIn).toBe(600_000);
});

test('QueueError names the queue and the job, and is a QueueError by name', () => {
	const e = new QueueError(
		'NOT_FOUND',
		'mails',
		'retry on "mails": no failed job j1',
		'j1',
	);
	expect([e.code, e.queue, e.job, e.name]).toEqual([
		'NOT_FOUND',
		'mails',
		'j1',
		'QueueError',
	]);
});

test('QueueError has no own job or lastError key when none was given', () => {
	const bare = new QueueError('FAILED', 'q', 'm');
	expect(Object.keys(bare)).not.toContain('job');
	expect(Object.keys(bare)).not.toContain('lastError');
	expect('job' in bare).toBe(false);
	expect('lastError' in bare).toBe(false);
});

test('QueueError carries lastError when given one', () => {
	const e = new QueueError('FAILED', 'q', 'm', 'j1', {
		name: 'Boom',
		message: 'detail',
	});
	expect(e.lastError).toEqual({ name: 'Boom', message: 'detail' });
	expect(Object.keys(e)).toContain('lastError');
	expect(Object.keys(e)).toContain('job');
});
