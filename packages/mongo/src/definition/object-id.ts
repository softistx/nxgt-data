import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { InvalidIdError } from '../errors/data-error';

/** The 24 hex characters an `ObjectId` is written as. */
const HEX_24 = /^[0-9a-fA-F]{24}$/;

/**
 * An `ObjectId`, read by its BSON tag rather than with `instanceof`, which
 * answers `false` across two copies of the driver in one tree.
 */
export function isObjectId(value: unknown): value is ObjectId {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { _bsontype?: unknown })._bsontype === 'ObjectId'
	);
}

/** Is this the 24-character hex string an `ObjectId` is written as? */
export function isObjectIdString(value: unknown): value is string {
	return typeof value === 'string' && HEX_24.test(value);
}

/** An `ObjectId`, or a string that stands for one. */
export function isValidObjectId(value: unknown): boolean {
	return isObjectId(value) || isObjectIdString(value);
}

/**
 * The `ObjectId` this value stands for, or `undefined`. Never throws.
 *
 * Prefer it to `new ObjectId(value)`, which **invents a fresh id** when it is
 * given `null` or `undefined` — a missing route parameter then reads as a
 * perfectly valid id that matches nothing.
 */
export function tryObjectId(value: unknown): ObjectId | undefined {
	if (isObjectId(value)) return value;
	if (isObjectIdString(value)) return ObjectId.createFromHexString(value);
	return undefined;
}

function describe(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
	return `a ${typeof value}`;
}

/**
 * The `ObjectId` this value stands for. Throws `InvalidIdError` for anything
 * else, `null` and `undefined` included.
 *
 * ```ts
 * const user = await users.getById(toObjectId(request.params.id));
 * ```
 */
export function toObjectId(value: unknown, field = '_id'): ObjectId {
	const made = tryObjectId(value);
	if (made) return made;
	throw new InvalidIdError(
		`${field}: expected an ObjectId or its 24-character hex string, got ${describe(value)}`,
		{ id: value, keys: [field] },
	);
}

/**
 * The same, for a list — a `$in` filter built from query parameters.
 *
 * ```ts
 * await users.findMany({ filter: { _id: { $in: toObjectIds(ids) } } });
 * ```
 */
export function toObjectIds(
	values: Iterable<unknown>,
	field = '_id',
): ObjectId[] {
	return [...values].map((value) => toObjectId(value, field));
}

/**
 * A Zod schema for an id that arrives from outside: it takes an `ObjectId` or
 * its hex string and gives back an `ObjectId`.
 *
 * It belongs in the schema of a route's parameters, **not** in a collection's:
 * a field that parses one type into another has no honest `$jsonSchema`, and
 * what a collection stores is `objectId()`.
 *
 * ```ts
 * const params = z.object({ id: objectIdParam() });
 * const { id } = params.parse(request.params);  // ObjectId
 * ```
 */
export function objectIdParam() {
	return z
		.custom<ObjectId | string>(isValidObjectId, {
			error: 'must be an ObjectId or its 24-character hex string',
		})
		.transform((value) => toObjectId(value));
}
