import type { BackupSource, Since, SourceEntry } from '@nxgt/backup';
import type { Db } from 'mongodb';
import { MongoBackupError } from '../errors';
import { CHANGES, changesName } from '../format/names';
import { type Position, readPosition, writePosition } from '../format/position';
import { changesOf } from './changes';
import type { CollectionFilter } from './collections';
import { differenceOf, fitting, followedFrom, heldByFull } from './followed';
import { operationTime, snapshotEntries } from './snapshot';

export interface MongoSourceOptions {
	/** The database to back up. Its client must reach a replica set or a sharded cluster. */
	db: Db;
	/**
	 * Which collections and views: their names, or a test on each name.
	 * Every one but `system.*` by default. A name listed that the database
	 * lacks is a `TypeError`.
	 */
	collections?: CollectionFilter | undefined;
}

function checkOptions(options: MongoSourceOptions): void {
	const db = options?.db as Partial<Db> | undefined;
	if (typeof db?.watch !== 'function' || typeof db.databaseName !== 'string') {
		throw new TypeError('mongoSource: db must be a MongoDB Db');
	}
	const filter = options.collections;
	if (
		filter !== undefined &&
		typeof filter !== 'function' &&
		!(Array.isArray(filter) && filter.every((n) => typeof n === 'string'))
	) {
		throw new TypeError(
			'mongoSource: collections must be a list of names or a function',
		);
	}
}

/**
 * The entries an incremental or differential backup adds: those of the
 * backup it builds on, untouched — their fingerprints say so, and they are
 * never opened — then one more, the changes since that backup's position.
 */
async function* changesEntries(
	options: MongoSourceOptions,
	since: Since,
	record: (position: Position) => void,
): AsyncGenerator<SourceEntry> {
	const from = readPosition(since.position);
	if (!from) {
		throw new MongoBackupError(
			'mongoSource: the backup built on recorded no position this version ' +
				'reads; make a full backup',
			'MALFORMED',
		);
	}
	const full = heldByFull(since);
	const held = followedFrom(full, from);
	const until = await operationTime(options.db);
	let changes = 0;
	for (const [name, known] of since.entries) {
		if (name.startsWith(CHANGES)) changes++;
		yield {
			name,
			fingerprint: known.fingerprint,
			open: () => {
				throw new MongoBackupError(
					'mongoSource: an entry of the backup built on was asked for again; ' +
						'it has no fingerprint, so make a full backup',
					'MALFORMED',
				);
			},
		};
	}
	const name = changesName(changes + 1);
	yield {
		name,
		fingerprint: `changes:${since.id}:${name}`,
		open: () =>
			changesOf(
				options.db,
				from.resume,
				held,
				until,
				options.collections,
				(resume) => record({ resume, ...differenceOf(full, held) }),
			),
	};
}

/**
 * A MongoDB database as a backup source. A full backup reads every
 * collection in one snapshot — one cluster time for the whole database —
 * as `metadata/<name>` (options and indexes) and `documents/<name>`
 * (concatenated BSON, as `mongodump` writes it); views have metadata only,
 * and GridFS buckets are collections like any other. An incremental or
 * differential backup reads the change stream from where the backup it
 * builds on stopped, into one `changes/<n>` entry.
 */
export function mongoSource(options: MongoSourceOptions): BackupSource {
	checkOptions(options);
	let position: string | undefined;
	const record = (at: Position) => {
		position = fitting(writePosition(at));
	};
	return {
		kind: 'mongo',
		entries(since) {
			position = undefined;
			return since
				? changesEntries(options, since, record)
				: snapshotEntries(options.db, options.collections, (start) =>
						record({
							resume: { startAtOperationTime: start },
							added: [],
							removed: [],
						}),
					);
		},
		position: () => position,
	};
}
