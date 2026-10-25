import { describe, expect, test } from 'bun:test';
import { createRowAssembler } from './row-assembler';

/** Rows of filter 0 (the bytes are the pixels), `stride` wide, numbered 1... */
function bytesOf(stride: number, height: number): Uint8Array {
	const out = new Uint8Array((stride + 1) * height);
	for (let y = 0; y < height; y++)
		out.fill(y + 1, y * (stride + 1) + 1, (y + 1) * (stride + 1));
	return out;
}

describe('createRowAssembler', () => {
	test('gives the same rows whatever the chunk size', () => {
		const data = bytesOf(5, 4);
		for (const size of [1, 2, 3, 6, 7, data.length]) {
			const seen: number[][] = [];
			const rows = createRowAssembler(5, 4, 1, (row, y) => {
				seen[y] = [...row.subarray(1)];
				return true;
			});
			for (let at = 0; at < data.length; at += size) {
				expect(rows.feed(data.subarray(at, at + size))).toBe(true);
			}
			expect(rows.rows).toBe(4);
			expect(seen).toEqual([1, 2, 3, 4].map((n) => new Array(5).fill(n)));
		}
	});

	test('stops when onRow says so, and reads no further', () => {
		let calls = 0;
		const rows = createRowAssembler(5, 4, 1, () => ++calls < 2);
		expect(rows.feed(bytesOf(5, 4))).toBe(false);
		expect(calls).toBe(2);
		expect(rows.rows).toBe(2);
	});

	test('refuses more rows than the header says, and an unknown filter', () => {
		const rows = createRowAssembler(5, 1, 1, () => true);
		expect(() => rows.feed(bytesOf(5, 2))).toThrow(
			'longer than the header says',
		);
		const bad = bytesOf(5, 1);
		bad[0] = 9;
		expect(() => createRowAssembler(5, 1, 1, () => true).feed(bad)).toThrow(
			'unknown filter',
		);
	});
});
