import { describe, expect, test } from 'bun:test';
import { bindIndex } from '@nxgt/meilisearch';
import { getCollection } from '@nxgt/mongo';
import { Meilisearch } from 'meilisearch';
import { MongoClient } from 'mongodb';
import { articleIndex, articles, toHit } from '../test/fixtures';
import { createSearchSync } from './create-search-sync';
import { keyOf } from './documents';
import { failed, SearchSyncError } from './errors';

// Neither client connects before its first request, and none is made here.
const db = new MongoClient('mongodb://127.0.0.1:1').db('unused');
const meili = new Meilisearch({ host: 'http://127.0.0.1:1' });
const base = {
	collection: getCollection(db, articles),
	index: bindIndex(meili, articleIndex),
	transform: toHit,
};

describe('createSearchSync', () => {
	test('is named after its collection and index, unless named', () => {
		expect(createSearchSync(base).name).toBe('articles:articles');
		expect(createSearchSync({ ...base, name: 'mine' }).name).toBe('mine');
	});

	test('refuses an empty name and a transform that is not a function', () => {
		expect(() => createSearchSync({ ...base, name: '' })).toThrow(
			'createSearchSync: name must not be empty',
		);
		expect(() =>
			// @ts-expect-error a transform is a function
			createSearchSync({ ...base, transform: 'no' }),
		).toThrow('createSearchSync: transform must be a function');
	});

	test.each([
		['batchSize', 0],
		['batchSize', 1.5],
		['pageSize', -1],
		['leaseMs', 0],
	] as const)('refuses %s %p', (option, value) => {
		expect(() => createSearchSync({ ...base, [option]: value })).toThrow(
			`createSearchSync: ${option} must be a whole number above 0, not ${value}`,
		);
	});

	test('takes a flushIntervalMs of 0, and refuses one below', () => {
		expect(() =>
			createSearchSync({ ...base, flushIntervalMs: 0 }),
		).not.toThrow();
		expect(() => createSearchSync({ ...base, flushIntervalMs: -1 })).toThrow(
			'createSearchSync: flushIntervalMs must be a whole number of milliseconds, not -1',
		);
		expect(() =>
			createSearchSync({ ...base, flushIntervalMs: Number.NaN }),
		).toThrow('not NaN');
	});
});

describe('ids and errors', () => {
	test('1 and "1" are different ids', () => {
		expect(keyOf(1)).not.toBe(keyOf('1'));
		expect(keyOf('a')).toBe(keyOf('a'));
	});

	test('an error is wrapped once, with its cause', () => {
		const cause = new Error('down');
		const wrapped = failed('s', 'doing it', cause);
		expect(wrapped).toBeInstanceOf(SearchSyncError);
		expect(wrapped.name).toBe('SearchSyncError');
		expect(wrapped.message).toBe('Search sync "s" failed doing it: down');
		expect(wrapped.cause).toBe(cause);
		expect(failed('t', 'again', wrapped)).toBe(wrapped);
		expect(failed('s', 'x', 'plain').message).toBe(
			'Search sync "s" failed x: plain',
		);
		expect(
			'cause' in new SearchSyncError('m', { code: 'FAILED', sync: 's' }),
		).toBe(false);
	});
});
