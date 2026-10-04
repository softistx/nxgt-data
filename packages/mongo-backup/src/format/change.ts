import { BSON, type Document } from 'mongodb';
import { isDocument } from './document';

/**
 * One change as a backup records it: what applying it again needs, and no
 * more — a document written, updated or deleted, or a collection created,
 * indexed, modified, renamed or dropped.
 */
export type Change =
	| { op: 'insert' | 'replace'; coll: string; key: Document; doc: Document }
	| {
			op: 'update';
			coll: string;
			key: Document;
			set: Document;
			unset: string[];
			truncated: { field: string; newSize: number }[];
	  }
	| { op: 'delete'; coll: string; key: Document }
	| { op: 'create'; coll: string; options: Document }
	| { op: 'createIndexes'; coll: string; indexes: Document[] }
	| { op: 'dropIndexes'; coll: string; names: string[] }
	| { op: 'modify'; coll: string; changes: Document }
	| { op: 'drop'; coll: string }
	| { op: 'rename'; coll: string; to: string; dropTarget: boolean }
	| { op: 'dropDatabase' };

/** What BSON keeps exactly: no number becomes another kind of number. */
export const EXACT = { promoteValues: false, bsonRegExp: true } as const;

export function writeChange(change: Change): Uint8Array {
	return BSON.serialize(change);
}

const isStrings = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === 'string');

/** The change a record holds, or nothing when it is not one this version wrote. */
export function readChange(bytes: Uint8Array): Change | undefined {
	const value = BSON.deserialize(bytes, EXACT);
	const { op, coll } = value;
	if (op === 'dropDatabase') return { op };
	if (typeof coll !== 'string' || coll.length === 0) return undefined;
	switch (op) {
		case 'insert':
		case 'replace':
			return isDocument(value['key']) && isDocument(value['doc'])
				? { op, coll, key: value['key'], doc: value['doc'] }
				: undefined;
		case 'update':
			return readUpdate(coll, value);
		case 'delete':
			return isDocument(value['key'])
				? { op, coll, key: value['key'] }
				: undefined;
		case 'create':
			return isDocument(value['options'])
				? { op, coll, options: value['options'] }
				: undefined;
		case 'createIndexes': {
			const indexes = value['indexes'];
			return Array.isArray(indexes) && indexes.every(isDocument)
				? { op, coll, indexes }
				: undefined;
		}
		case 'dropIndexes':
			return isStrings(value['names'])
				? { op, coll, names: value['names'] }
				: undefined;
		case 'modify':
			return isDocument(value['changes'])
				? { op, coll, changes: value['changes'] }
				: undefined;
		case 'drop':
			return { op, coll };
		case 'rename':
			return typeof value['to'] === 'string' &&
				typeof value['dropTarget'] === 'boolean'
				? { op, coll, to: value['to'], dropTarget: value['dropTarget'] }
				: undefined;
		default:
			return undefined;
	}
}

function readUpdate(coll: string, value: Document): Change | undefined {
	const { key, set, unset, truncated } = value;
	if (
		!isDocument(key) ||
		!isDocument(set) ||
		!isStrings(unset) ||
		!Array.isArray(truncated)
	) {
		return undefined;
	}
	const cuts: { field: string; newSize: number }[] = [];
	for (const cut of truncated) {
		const size = Number(cut?.newSize);
		if (typeof cut?.field !== 'string' || !Number.isSafeInteger(size)) {
			return undefined;
		}
		cuts.push({ field: cut.field, newSize: size });
	}
	return { op: 'update', coll, key, set, unset, truncated: cuts };
}
