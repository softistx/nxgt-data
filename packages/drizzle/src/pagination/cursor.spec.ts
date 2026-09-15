import { describe, expect, test } from 'bun:test';
import { InvalidCursorError } from '../errors/data-error';
import { decodeCursor, encodeCursor } from './cursor';

describe('encodeCursor and decodeCursor', () => {
	test('round-trip strings, numbers, a Date and a bigint', () => {
		const date = new Date('2026-09-15T10:20:30.123Z');
		const cursor = encodeCursor({
			key: 'createdAt:desc',
			values: [date, 42, 'é/+?', 9007199254740993n],
		});
		const { key, values } = decodeCursor(cursor);
		expect(key).toBe('createdAt:desc');
		expect(values[0]).toBeInstanceOf(Date);
		expect((values[0] as Date).getTime()).toBe(date.getTime());
		expect(values.slice(1)).toEqual([42, 'é/+?', 9007199254740993n]);
	});

	test('write a URL-safe string', () => {
		const cursor = encodeCursor({ key: 'id:asc', values: ['???>>>~~~'] });
		expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	test('refuse a cursor that is not one', () => {
		expect(() => decodeCursor('not a cursor!')).toThrow(InvalidCursorError);
		expect(() => decodeCursor(btoa('{"a":1}'))).toThrow('unexpected shape');
	});

	test('refuse a cursor written for another ordering', () => {
		const cursor = encodeCursor({ key: 'id:asc', values: [1] });
		expect(() => decodeCursor(cursor, 'id:desc')).toThrow(
			'written for the ordering id:asc, not id:desc',
		);
		expect(decodeCursor(cursor, 'id:asc').values).toEqual([1]);
	});

	test('its error is a DataError with a code', () => {
		try {
			decodeCursor('%%%');
		} catch (error) {
			expect((error as InvalidCursorError).code).toBe('INVALID_CURSOR');
			return;
		}
		throw new Error('expected a throw');
	});
});
