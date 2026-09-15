import { describe, expect, test } from 'bun:test';
import { cursorLimit, pageWindow, toPage } from './page';

describe('pageWindow', () => {
	test('defaults to the first page of 20', () => {
		expect(pageWindow()).toEqual({
			page: 1,
			pageSize: 20,
			limit: 20,
			offset: 0,
		});
	});

	test('turns a page into an offset', () => {
		expect(pageWindow({ page: 3, pageSize: 10 })).toEqual({
			page: 3,
			pageSize: 10,
			limit: 10,
			offset: 20,
		});
	});

	test('lowers a pageSize above the maximum', () => {
		expect(pageWindow({ pageSize: 1000 }).pageSize).toBe(100);
		expect(pageWindow({ pageSize: 1000 }, 50).pageSize).toBe(50);
	});

	test('refuses what is not a positive integer', () => {
		expect(() => pageWindow({ page: 0 })).toThrow(RangeError);
		expect(() => pageWindow({ page: 1.5 })).toThrow('page must be an integer');
		expect(() => pageWindow({ pageSize: -1 })).toThrow(RangeError);
		expect(() => pageWindow({ pageSize: Number.NaN })).toThrow(RangeError);
	});
});

describe('toPage', () => {
	test('counts the pages', () => {
		const window = pageWindow({ page: 2, pageSize: 10 });
		expect(toPage(['a'], 21, window)).toEqual({
			items: ['a'],
			total: 21,
			page: 2,
			pageSize: 10,
			pageCount: 3,
		});
		expect(toPage([], 0, window).pageCount).toBe(0);
	});
});

describe('cursorLimit', () => {
	test('defaults, lowers and refuses as pageWindow does', () => {
		expect(cursorLimit(undefined)).toBe(20);
		expect(cursorLimit(500)).toBe(100);
		expect(() => cursorLimit(0)).toThrow(RangeError);
	});
});
