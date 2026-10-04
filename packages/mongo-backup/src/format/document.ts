import type { Document } from 'mongodb';

/**
 * Whether `value` is a document: an object that is neither an array nor a
 * BSON value — read with `promoteValues: false`, an `Int32` is an object too.
 */
export function isDocument(value: unknown): value is Document {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		!('_bsontype' in value)
	);
}
