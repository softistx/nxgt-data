import { describe, expect, test } from 'bun:test';
import { queueKeys } from '../keys';
import type { WorkerContext } from './context';
import { fireDue, MAX_WAIT, waitMs } from './fire';

const none = { sent: 0, added: 0, soonest: Number.POSITIVE_INFINITY };
const sent = { sent: 3, added: 3, soonest: Number.POSITIVE_INFINITY };

describe('waitMs', () => {
	test('honours a 0 only when something was sent that round', () => {
		expect(waitMs(0, sent, 1000)).toBe(0);
		expect(waitMs(0, none, 1000)).toBe(MAX_WAIT);
	});

	test('takes the reply, capped, and the cap for none', () => {
		expect(waitMs(1200, none, 0)).toBe(1200);
		expect(waitMs(60_000, none, 0)).toBe(MAX_WAIT);
		expect(waitMs(-1, none, 0)).toBe(MAX_WAIT);
	});

	test('waits no longer than a fired schedule needs', () => {
		const round = { sent: 1, added: 1, soonest: 10_800 };
		expect(waitMs(-1, round, 10_000)).toBe(800);
		expect(waitMs(300, round, 10_000)).toBe(300);
		expect(waitMs(-1, { ...round, soonest: 9_000 }, 10_000)).toBe(0);
	});
});

describe('fireDue with a failing script', () => {
	test('counts nothing sent, so a full page never makes the loop spin', async () => {
		const errors: unknown[] = [];
		const context = {
			open: true,
			client: {
				evalsha: () => Promise.reject(new Error('OOM command not allowed')),
			},
			keys: queueKeys('mails'),
			definition: { name: 'mails', attempts: 3, timeout: undefined },
			listeners: { error: new Set([(e: unknown) => errors.push(e)]) },
		} as unknown as WorkerContext;
		const page = Array.from({ length: 20 }, (_, i) => ({
			id: `s${i}`,
			kind: 'every' as const,
			spec: '60000',
			timezone: '',
			due: 1000,
		}));
		const round = await fireDue(context, page);
		// The round ends at the first failure, and says so on `error`.
		expect(errors).toHaveLength(1);
		expect(round).toEqual({
			sent: 0,
			added: 0,
			soonest: Number.POSITIVE_INFINITY,
		});
		expect(waitMs(0, round, Date.now())).toBe(MAX_WAIT);
	});
});
