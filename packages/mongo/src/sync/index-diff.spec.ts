import { describe, expect, test } from 'bun:test';
import type { IndexDescriptionInfo } from 'mongodb';
import {
	diffIndexes,
	indexMatches,
	indexNameOf,
	normalizeIndex,
} from './index-diff';

/** A collation as the server reads it back: every field, plus its ICU version. */
const liveCollation = {
	locale: 'fr',
	caseLevel: false,
	caseFirst: 'off',
	strength: 2,
	numericOrdering: false,
	alternate: 'non-ignorable',
	maxVariable: 'punct',
	normalization: false,
	backwards: false,
	version: '57.1',
};

describe('indexNameOf', () => {
	test('builds the name MongoDB gives an index that names none', () => {
		expect(indexNameOf({ rank: 1, title: -1 })).toBe('rank_1_title_-1');
		expect(indexNameOf({ location: '2dsphere' })).toBe('location_2dsphere');
	});
});

describe('normalizeIndex', () => {
	test('drops the server’s own bookkeeping', () => {
		const live = {
			v: 2,
			key: { email: 1 },
			name: 'users_email_unique',
			unique: true,
			ns: 'db.users',
		} as unknown as IndexDescriptionInfo;
		expect(normalizeIndex(live)).toEqual({
			name: 'users_email_unique',
			key: { email: 1 },
			options: { unique: true },
		});
	});

	test('drops an option that is its own default, sent or not', () => {
		// The server reads `sparse: false` back when it was passed explicitly,
		// and leaves it out otherwise: both mean the same index.
		expect(
			normalizeIndex({ key: { a: 1 }, name: 'a', sparse: false }).options,
		).toEqual({});
	});
});

describe('indexMatches', () => {
	test('a collation matches the canonical form the server fills in', () => {
		expect(
			indexMatches(
				{
					key: { name: 1 },
					name: 'by_name',
					collation: { locale: 'fr', strength: 2 },
				},
				{
					v: 2,
					key: { name: 1 },
					name: 'by_name',
					collation: liveCollation,
				} as unknown as IndexDescriptionInfo,
			),
		).toBe(true);
	});

	test('another collation strength is another index', () => {
		expect(
			indexMatches(
				{
					key: { name: 1 },
					name: 'by_name',
					collation: { locale: 'fr', strength: 3 },
				},
				{
					v: 2,
					key: { name: 1 },
					name: 'by_name',
					collation: liveCollation,
				} as unknown as IndexDescriptionInfo,
			),
		).toBe(false);
	});

	test('a compound index in another order is another index', () => {
		const live = {
			v: 2,
			key: { rank: 1, title: 1 },
			name: 'compound',
		} as unknown as IndexDescriptionInfo;
		expect(
			indexMatches({ key: { rank: 1, title: 1 }, name: 'compound' }, live),
		).toBe(true);
		expect(
			indexMatches({ key: { title: 1, rank: 1 }, name: 'compound' }, live),
		).toBe(false);
	});

	test('a changed option is a changed index', () => {
		const live = {
			v: 2,
			key: { createdAt: 1 },
			name: 'ttl',
			expireAfterSeconds: 60,
		} as unknown as IndexDescriptionInfo;
		expect(
			indexMatches(
				{ key: { createdAt: 1 }, name: 'ttl', expireAfterSeconds: 60 },
				live,
			),
		).toBe(true);
		expect(
			indexMatches(
				{ key: { createdAt: 1 }, name: 'ttl', expireAfterSeconds: 90 },
				live,
			),
		).toBe(false);
	});
});

describe('diffIndexes', () => {
	const live = [
		{ v: 2, key: { _id: 1 }, name: '_id_' },
		{ v: 2, key: { email: 1 }, name: 'users_email_unique', unique: true },
		{ v: 2, key: { age: 1 }, name: 'by_hand' },
	] as unknown as IndexDescriptionInfo[];

	test('creates, keeps, rebuilds, and leaves _id_ alone', () => {
		const diff = diffIndexes(
			[
				{ key: { email: 1 }, unique: true, name: 'users_email_unique' },
				// The same name with other options: MongoDB refuses to alter it.
				{ key: { createdAt: -1 }, name: 'by_hand' },
				{ key: { name: 1 }, name: 'users_name' },
			],
			live,
		);
		expect(diff.unchanged).toEqual(['users_email_unique']);
		expect(diff.recreate.map((index) => index.name)).toEqual(['by_hand']);
		expect(diff.create.map((index) => index.name)).toEqual(['users_name']);
		expect(diff.extra).toEqual([]);
	});

	test('names the indexes no definition asks for, never _id_', () => {
		const diff = diffIndexes([], live);
		expect(diff.extra).toEqual(['users_email_unique', 'by_hand']);
		expect(diff.create).toEqual([]);
	});

	test('an index that names itself nothing is matched by MongoDB’s name', () => {
		const diff = diffIndexes([{ key: { age: 1 } }], live);
		expect(diff.create.map((index) => index.name)).toEqual(['age_1']);
		expect(diff.extra).toContain('by_hand');
	});
});
