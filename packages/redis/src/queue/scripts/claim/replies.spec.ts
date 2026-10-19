import { describe, expect, test } from 'bun:test';
import { parseAddReply, parseStepBegin, parseStepCommit } from './replies';

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

describe('parseAddReply', () => {
	test('reads added, existing and held-by shapes, never values', () => {
		expect(parseAddReply([0, 1, 'j7'], 3)).toEqual([
			{ deduplicated: false, held: undefined },
			{ deduplicated: true, held: undefined },
			{ deduplicated: true, held: 'j7' },
		]);
		for (const bad of [
			null,
			0,
			[0],
			[0, 0, 0],
			[2, 0],
			[-1, 0],
			['', 0],
			[null, 0],
			[[], 0],
			[true, 0],
		]) {
			expect(() => parseAddReply(bad, 2)).toThrow(refusal);
		}
	});
});
