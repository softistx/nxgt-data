import { describe, expect, test } from 'bun:test';
import type { Db } from 'mongodb';
import { posts } from '../../test/schema';
import { DataError } from '../errors/data-error';
import { applyIndexes, createCollection, type SyncStep } from './phases';
import { liveIndexes, writeOptions, writeValidation } from './server';
import { syncCollection } from './sync-collection';

// The answers a real mongod gives only to a user without a role, or to two
// syncs racing each other: neither can be produced on demand, so these specs
// hand sync a `Db` that answers them.

const serverError = (code: number, message = `error ${code}`) =>
	Object.assign(new Error(message), { code });

interface Script {
	command?: () => unknown;
	createCollection?: () => unknown;
	/** One answer per call to `listCollections`, the last one repeated. */
	listed?: Record<string, unknown>[][];
	indexes?: () => unknown;
	createIndexes?: () => unknown;
}

function scriptedDb(script: Script): Db {
	let listings = 0;
	const listed = script.listed ?? [[]];
	return {
		command: async () => script.command?.(),
		createCollection: async () => script.createCollection?.(),
		listCollections: () => ({
			toArray: async () =>
				listed[Math.min(listings++, listed.length - 1)] ?? [],
		}),
		collection: () => ({
			indexes: async () =>
				script.indexes ? script.indexes() : [{ name: '_id_', key: { _id: 1 } }],
			dropIndex: async () => undefined,
			createIndexes: async () => script.createIndexes?.(),
		}),
	} as unknown as Db;
}

/** What a sync asks for when the definition turns the validator off. */ const wantedOff =
	{
		validator: undefined,
		level: 'off',
		action: 'error',
	} as const;

const stepOn = (db: Db): SyncStep => ({
	db,
	definition: posts,
	session: undefined,
	dryRun: false,
});

describe('collMod without the role for it', () => {
	const db = scriptedDb({
		command: () => {
			throw serverError(13, 'not authorized');
		},
	});

	test('a validator names the role it needs', async () => {
		const failing = writeValidation(
			db,
			'posts',
			{ validator: {}, level: 'strict', action: 'error' },
			undefined,
		);
		await expect(failing).rejects.toBeInstanceOf(DataError);
		await expect(failing).rejects.toMatchObject({
			collection: 'posts',
			serverCode: 13,
		});
		await expect(failing).rejects.toThrow('`dbAdmin` does');
	});

	test('so does a collection option', async () => {
		await expect(
			writeOptions(db, 'posts', { cappedSize: 1 }, undefined),
		).rejects.toThrow('not allowed to run collMod on "posts"');
	});

	test('any other refusal becomes a DataError of its own', async () => {
		const other = scriptedDb({
			command: () => {
				throw serverError(72, 'invalid options');
			},
		});
		await expect(
			writeOptions(other, 'posts', { cappedSize: 1 }, undefined),
		).rejects.toMatchObject({ serverCode: 72, collection: 'posts' });
	});
});

describe('the indexes of a collection that is not there', () => {
	test('are none', async () => {
		const db = scriptedDb({
			indexes: () => {
				throw serverError(26, 'ns does not exist');
			},
		});
		expect(await liveIndexes(db, 'posts', undefined)).toEqual([]);
	});

	test('any other failure is not swallowed', async () => {
		const db = scriptedDb({
			indexes: () => {
				throw serverError(13, 'not authorized');
			},
		});
		await expect(liveIndexes(db, 'posts', undefined)).rejects.toMatchObject({
			code: 13,
		});
	});
});

describe('two syncs creating the same collection', () => {
	test('the loser goes on with the collection the winner made', async () => {
		const db = scriptedDb({
			createCollection: () => {
				throw serverError(48, 'collection already exists');
			},
			listed: [[{ options: { capped: true, size: 4096 } }]],
		});
		expect(await createCollection(stepOn(db), wantedOff)).toEqual({
			capped: true,
			size: 4096,
		});
	});

	test('and reports it as found, not created', async () => {
		const db = scriptedDb({
			createCollection: () => {
				throw serverError(48, 'collection already exists');
			},
			// Missing when sync looks, there once it tries to create it.
			listed: [[], [{ options: {} }]],
		});
		const report = await syncCollection(db, posts);
		expect(report.created).toBe(false);
		// The winner wrote no validator, so this sync writes one.
		expect(report.validator).toBe('created');
		expect(report.indexes.created).toEqual(['posts_rank_title']);
	});

	test('any other creation failure is a DataError', async () => {
		const db = scriptedDb({
			createCollection: () => {
				throw serverError(72, 'invalid options');
			},
		});
		await expect(createCollection(stepOn(db), wantedOff)).rejects.toMatchObject(
			{ serverCode: 72, collection: 'posts' },
		);
	});
});

describe('an index the server refuses to build', () => {
	test('is a DataError naming the collection', async () => {
		const db = scriptedDb({
			createIndexes: () => {
				throw serverError(67, 'cannot create index');
			},
		});
		await expect(applyIndexes(stepOn(db), false, false)).rejects.toMatchObject({
			serverCode: 67,
			collection: 'posts',
		});
	});
});
