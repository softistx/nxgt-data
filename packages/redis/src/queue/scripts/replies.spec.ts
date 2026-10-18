import { describe, expect, test } from 'bun:test';
import { parseStepBegin, parseStepCommit } from './replies';

const refusal = 'queue script reply not recognised';

describe('step replies', () => {
	test('parseStepBegin refuses a drifted reply', () => {
		expect(parseStepBegin([-1])).toEqual({ lost: true });
		expect(parseStepBegin([0])).toEqual({ stored: false });
		expect(parseStepBegin([1, ''])).toEqual({ stored: true, json: '' });
		for (const bad of [1, null, [], [2], [1], [1, 5], [0, 'x'], ['1']]) {
			expect(() => parseStepBegin(bad)).toThrow(refusal);
		}
	});

	test('parseStepCommit accepts exactly 1 or 0', () => {
		expect(parseStepCommit(1)).toBe(true);
		expect(parseStepCommit(0)).toBe(false);
		for (const bad of [2, -1, '1', null, true, [1]]) {
			expect(() => parseStepCommit(bad)).toThrow(refusal);
		}
	});
});
