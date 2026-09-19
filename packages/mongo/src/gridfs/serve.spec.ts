import { describe, expect, test } from 'bun:test';
import { parseRange } from './serve';

describe('parseRange', () => {
	// `end` is exclusive here, because that is how `openDownloadStream` reads
	// it — measured — while a `Range` header's is inclusive. The conversion
	// lives in this one function, so nothing else has to remember it.
	test('reads a range with both ends', () => {
		expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 100 });
		expect(parseRange('bytes=10-19', 1000)).toEqual({ start: 10, end: 20 });
	});

	test('reads a range that runs to the end', () => {
		expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 1000 });
	});

	test('reads a suffix range, and clamps it to the file', () => {
		expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 1000 });
		expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 1000 });
	});

	test('clamps an end past the file rather than asking for nothing', () => {
		expect(parseRange('bytes=900-5000', 1000)).toEqual({
			start: 900,
			end: 1000,
		});
	});

	test('says when a range cannot be satisfied', () => {
		expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
		expect(parseRange('bytes=1200-1300', 1000)).toBe('unsatisfiable');
		expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
	});

	test('a file of no bytes satisfies no range at all', () => {
		// The two branches have to agree: `bytes=0-` on an empty file was
		// already unsatisfiable, and `bytes=-100` answered the whole of
		// nothing with a `200`.
		expect(parseRange('bytes=-100', 0)).toBe('unsatisfiable');
		expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
		expect(parseRange('bytes=0-10', 0)).toBe('unsatisfiable');
	});

	test('ignores what it will not honour, rather than failing the request', () => {
		expect(parseRange(null, 1000)).toBeUndefined();
		expect(parseRange('bytes=0-99, 200-299', 1000)).toBeUndefined();
		expect(parseRange('items=0-99', 1000)).toBeUndefined();
		expect(parseRange('bytes=-', 1000)).toBeUndefined();
	});
});
