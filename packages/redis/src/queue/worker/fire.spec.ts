import { describe, expect, test } from 'bun:test';
import { MAX_WAIT, waitMs } from './fire';

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
