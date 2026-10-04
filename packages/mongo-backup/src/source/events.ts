import type { ChangeStreamDocument, Document, Timestamp } from 'mongodb';
import { MongoBackupError } from '../errors';
import type { Change } from '../format/change';
import { type CollectionFilter, takes } from './collections';

/** A change-stream event, with `showExpandedEvents`: the fields read from it. */
export type Event = ChangeStreamDocument & {
	clusterTime?: Timestamp;
	fullDocument?: Document | null;
	documentKey?: Document;
	ns?: { db: string; coll?: string };
	nsType?: string;
	to?: { db: string; coll: string };
	operationDescription?: Document;
	updateDescription?: {
		updatedFields?: Document;
		removedFields?: string[];
		truncatedArrays?: { field: string; newSize: number }[];
		disambiguatedPaths?: Document;
	};
};

const unsupported = (what: string) =>
	new MongoBackupError(`mongoSource: ${what}`, 'UNSUPPORTED');

/** The update an event records: its post-image if it has one, its description otherwise. */
function updateOf(event: Event, coll: string, key: Document): Change {
	if (event.fullDocument) {
		return { op: 'replace', coll, key, doc: event.fullDocument };
	}
	const update = event.updateDescription ?? {};
	if (Object.keys(update.disambiguatedPaths ?? {}).length > 0) {
		throw unsupported(
			'an update touched a field whose name holds a dot or is a number, ' +
				'which a change cannot say without its post-image; turn on ' +
				'changeStreamPreAndPostImages for that collection, or make a full backup',
		);
	}
	return {
		op: 'update',
		coll,
		key,
		set: update.updatedFields ?? {},
		unset: update.removedFields ?? [],
		truncated: (update.truncatedArrays ?? []).map((cut) => ({
			field: cut.field,
			newSize: Number(cut.newSize),
		})),
	};
}

/** A change to a collection itself, from its expanded event. */
function ddlOf(event: Event, coll: string, db: string): Change | undefined {
	const described = event.operationDescription ?? {};
	switch (event.operationType) {
		case 'create': {
			if (event.nsType === 'timeseries') {
				throw unsupported(
					'a collection is of a type this version does not back up ' +
						'(a time-series one); leave it out with collections',
				);
			}
			const { idIndex: _idIndex, ...options } = described;
			return { op: 'create', coll, options };
		}
		case 'createIndexes':
			return {
				op: 'createIndexes',
				coll,
				indexes: ((described['indexes'] ?? []) as Document[]).map(
					({ v: _v, ns: _ns, ...index }) => index,
				),
			};
		case 'dropIndexes':
			return {
				op: 'dropIndexes',
				coll,
				names: ((described['indexes'] ?? []) as Document[]).map((index) =>
					String(index['name']),
				),
			};
		case 'modify':
			return { op: 'modify', coll, changes: described };
		case 'drop':
			return { op: 'drop', coll };
		case 'rename':
			// Renamed out of the database: gone from it.
			// `dropTarget` there is the UUID of a collection the rename replaced.
			return event.to?.db === db
				? {
						op: 'rename',
						coll,
						to: event.to.coll,
						dropTarget: described['dropTarget'] !== undefined,
					}
				: { op: 'drop', coll };
		default:
			return undefined;
	}
}

/** The change an event records, or nothing when it is not one to keep. */
export function changeOf(event: Event, db: string): Change | undefined {
	const coll = event.ns?.coll ?? '';
	const key = event.documentKey ?? {};
	switch (event.operationType) {
		case 'insert':
		case 'replace':
			return {
				op: event.operationType,
				coll,
				key,
				doc: event.fullDocument ?? {},
			};
		case 'update':
			return updateOf(event, coll, key);
		case 'delete':
			return { op: 'delete', coll, key };
		case 'dropDatabase':
			return { op: 'dropDatabase' };
		default:
			return ddlOf(event, coll, db);
	}
}

/**
 * Whether an event is passed over before it is translated: one on a
 * collection the backup does not follow — or, for a creation, one the
 * filter does not take — so an update or a creation there that a change
 * could not say never fails the backup. A rename is never passed over
 * here: `followed` decides it.
 */
export function passedOver(
	event: Event,
	held: ReadonlySet<string>,
	filter: CollectionFilter | undefined,
): boolean {
	const coll = event.ns?.coll;
	if (coll === undefined || event.operationType === 'rename') return false;
	return event.operationType === 'create'
		? !takes(filter, coll)
		: !held.has(coll);
}

/**
 * The change as the backup keeps it, and `held` — the collections it
 * follows — brought up to date. A collection created that the filter takes
 * is followed from then on. A rename out of those followed is a drop, and
 * one into them is refused: the documents it brings were never read.
 */
export function followed(
	change: Change,
	held: Set<string>,
	filter: CollectionFilter | undefined,
): Change | undefined {
	switch (change.op) {
		case 'dropDatabase':
			// Before it, each collection's own drop: but no view has one.
			held.clear();
			return change;
		case 'create':
			held.add(change.coll);
			return change;
		case 'drop':
			held.delete(change.coll);
			return change;
		case 'rename':
			return renamed(change, held, filter);
		default:
			return change;
	}
}

function renamed(
	change: Extract<Change, { op: 'rename' }>,
	held: Set<string>,
	filter: CollectionFilter | undefined,
): Change | undefined {
	const from = held.has(change.coll);
	const to = takes(filter, change.to);
	if (from) held.delete(change.coll);
	if (from && to) {
		held.add(change.to);
		return change;
	}
	if (from) return { op: 'drop', coll: change.coll };
	if (to) {
		throw unsupported(
			'a collection was renamed into those backed up, with documents an ' +
				'incremental backup never read; make a full backup',
		);
	}
	return undefined;
}
