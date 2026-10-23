import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { InvalidCursorError } from '../errors/data-error';
import { cursorKey, decodeCursor, encodeCursor } from './cursor';

describe('encodeCursor and decodeCursor', () => {
	test('round-trip an ObjectId, a Date, a string and a number', () => {
		const _id = new ObjectId();
		const date = new Date('2026-09-15T10:20:30.123Z');
		const cursor = encodeCursor({
			key: 'createdAt:desc',
			values: [date, _id, 'é/+?', 42],
		});
		const { key, values } = decodeCursor(cursor);
		expect(key).toBe('createdAt:desc');
		expect(values[0]).toBeInstanceOf(Date);
		expect((values[0] as Date).getTime()).toBe(date.getTime());
		// The very ObjectId, not its hex: it is compared against `_id`.
		expect(values[1]).toBeInstanceOf(ObjectId);
		expect((values[1] as ObjectId).equals(_id)).toBe(true);
		expect(values.slice(2)).toEqual(['é/+?', 42]);
	});

	test('write a URL-safe string', () => {
		const cursor = encodeCursor({ key: '_id:asc', values: [new ObjectId()] });
		expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	test('refuse a cursor that is not one', () => {
		expect(() => decodeCursor('not a cursor!')).toThrow(InvalidCursorError);
		expect(() => decodeCursor(btoa('{"a":1}'))).toThrow('unexpected shape');
	});

	test('refuse a cursor written for another ordering', () => {
		const cursor = encodeCursor({ key: '_id:asc', values: [1] });
		expect(() => decodeCursor(cursor, '_id:desc')).toThrow(
			'written for the ordering _id:asc, not _id:desc',
		);
		expect(decodeCursor(cursor, '_id:asc').values).toEqual([1]);
	});

	test('a scoped key adds a hash, never the scope', () => {
		expect(cursorKey('_id:asc')).toBe('_id:asc');
		const key = cursorKey('_id:asc', 'tenant-42');
		expect(key).toMatch(/^_id:asc#[0-9a-f]{16}$/);
		expect(key).not.toContain('tenant-42');
	});

	test('name only the orderings, or another scope', () => {
		const a = cursorKey('_id:asc', 'a');
		const cursor = encodeCursor({ key: a, values: [1] });
		expect(decodeCursor(cursor, a).values).toEqual([1]);
		expect(() => decodeCursor(cursor, cursorKey('_id:desc', 'b'))).toThrow(
			'Invalid cursor: it was written for the ordering _id:asc, not _id:desc',
		);
		for (const other of [cursorKey('_id:asc', 'b'), '_id:asc']) {
			expect(() => decodeCursor(cursor, other)).toThrow(
				'Invalid cursor: it was written for another scope',
			);
		}
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
