import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { InvalidIdError } from '../errors/data-error';
import {
	isObjectId,
	isObjectIdString,
	isValidObjectId,
	objectIdParam,
	toObjectId,
	toObjectIds,
	tryObjectId,
} from './object-id';

const HEX = '507f1f77bcf86cd799439011';

describe('isObjectId', () => {
	test('reads the BSON tag, not the class', () => {
		expect(isObjectId(new ObjectId())).toBe(true);
		// What a second copy of the driver in the tree looks like: the same
		// shape, another class. `instanceof` would answer false.
		expect(isObjectId({ _bsontype: 'ObjectId' })).toBe(true);
		expect(isObjectId(HEX)).toBe(false);
		expect(isObjectId(null)).toBe(false);
	});
});

describe('isObjectIdString', () => {
	test('wants 24 hex characters, in either case', () => {
		expect(isObjectIdString(HEX)).toBe(true);
		expect(isObjectIdString(HEX.toUpperCase())).toBe(true);
		expect(isObjectIdString(`ZZZ${HEX.slice(3)}`)).toBe(false);
		expect(isObjectIdString(HEX.slice(1))).toBe(false);
		// A 12-character string is a byte string MongoDB once accepted, and it
		// is not a written id.
		expect(isObjectIdString('hello world!')).toBe(false);
		expect(isObjectIdString(new ObjectId())).toBe(false);
	});
});

describe('isValidObjectId', () => {
	test('an ObjectId or the string of one', () => {
		expect(isValidObjectId(new ObjectId())).toBe(true);
		expect(isValidObjectId(HEX)).toBe(true);
		expect(isValidObjectId('nope')).toBe(false);
		expect(isValidObjectId(undefined)).toBe(false);
	});
});

describe('tryObjectId', () => {
	test('gives the id back, or undefined, and never throws', () => {
		const made = new ObjectId();
		expect(tryObjectId(made)).toBe(made);
		expect(tryObjectId(HEX)?.toHexString()).toBe(HEX);
		expect(tryObjectId(HEX.toUpperCase())?.toHexString()).toBe(HEX);
		expect(tryObjectId('nope')).toBeUndefined();
		expect(tryObjectId(null)).toBeUndefined();
		expect(tryObjectId(undefined)).toBeUndefined();
		expect(tryObjectId(12)).toBeUndefined();
	});
});

describe('toObjectId', () => {
	test('converts, and names the field it refused', () => {
		expect(toObjectId(HEX).toHexString()).toBe(HEX);
		const error = (() => {
			try {
				toObjectId('nope', 'teamId');
			} catch (thrown) {
				return thrown;
			}
		})();
		expect(error).toBeInstanceOf(InvalidIdError);
		expect((error as InvalidIdError).code).toBe('INVALID_ID');
		expect((error as InvalidIdError).keys).toEqual(['teamId']);
		expect((error as InvalidIdError).id).toBe('nope');
		expect((error as Error).message).toBe(
			'teamId: expected an ObjectId or its 24-character hex string, got the string "nope"',
		);
	});

	test('refuses null and undefined, which the driver turns into a fresh id', () => {
		// The trap this helper exists for: a route parameter that never arrived
		// would otherwise become a perfectly valid id that matches nothing.
		expect(new ObjectId(undefined).toHexString()).toMatch(/^[0-9a-f]{24}$/);
		expect(() => toObjectId(undefined)).toThrow(
			'_id: expected an ObjectId or its 24-character hex string, got undefined',
		);
		expect(() => toObjectId(null)).toThrow('got null');
	});
});

describe('toObjectIds', () => {
	test('converts a list, and refuses the first that is not one', () => {
		expect(toObjectIds([HEX, new ObjectId(HEX)]).map(String)).toEqual([
			HEX,
			HEX,
		]);
		expect(toObjectIds([])).toEqual([]);
		expect(() => toObjectIds([HEX, 'nope'])).toThrow(InvalidIdError);
	});
});

describe('objectIdParam', () => {
	test('parses either form into an ObjectId', () => {
		const schema = objectIdParam();
		expect(schema.parse(HEX).toHexString()).toBe(HEX);
		const made = new ObjectId();
		expect(schema.parse(made).toHexString()).toBe(made.toHexString());
	});

	test('refuses anything else, as a Zod issue', () => {
		const result = objectIdParam().safeParse('nope');
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.message).toBe(
			'must be an ObjectId or its 24-character hex string',
		);
	});
});
