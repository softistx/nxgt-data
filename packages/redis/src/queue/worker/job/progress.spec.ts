import { describe, expect, test } from 'bun:test';
import { mailQueue } from '../../../../test/fixtures';
import { queueKeys } from '../../keys';
import type { WorkerContext } from '../context';
import { on } from '../events';
import { progressOf } from './progress';

describe('progressOf', () => {
	test('a run aborted while the store was on its way tells nobody', async () => {
		const controller = new AbortController();
		const context = {
			definition: mailQueue,
			keys: queueKeys('mails'),
			listeners: {},
			// The token still held when the script ran; the abort lands before
			// its reply is read.
			client: {
				evalsha: async () => {
					controller.abort();
					return 1;
				},
			},
		} as unknown as WorkerContext;
		const told: unknown[] = [];
		on(context, 'progress', (payload) => void told.push(payload));
		const job = {
			id: 'a',
			data: '{}',
			attempt: 1,
			attempts: 3,
			token: 't',
			timeout: undefined,
		};
		await progressOf(context, job, controller.signal)(40);
		expect(controller.signal.aborted).toBe(true);
		expect(told).toEqual([]);
	});
});
