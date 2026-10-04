import { BSON, type Document, type Timestamp } from 'mongodb';
import { isDocument } from './document';

const POSITION_FORMAT = 'nxgt-mongo-backup-position/1';

/**
 * Where a change stream starts: just after the cluster time a full backup's
 * snapshot read at, or after the last change an incremental one read.
 */
export type Resume =
	| { startAtOperationTime: Timestamp }
	| { startAfter: Document };

/**
 * Where the next incremental backup starts, and how the collections and
 * views it follows differ from those of the chain's full backup — each of
 * which has its `metadata/<name>` entry, so the position stays small
 * however many there are. A change to `collections` takes effect at the
 * next full backup, never halfway through a chain.
 */
export interface Position {
	resume: Resume;
	/** Followed now, with no metadata entry: created since the full backup. */
	added: string[];
	/** Not followed any more, though the full backup holds them. */
	removed: string[];
}

/** `position` as the backup records it: canonical Extended JSON. */
export function writePosition(position: Position): string {
	return BSON.EJSON.stringify(
		{
			format: POSITION_FORMAT,
			...position.resume,
			added: [...position.added].sort(),
			removed: [...position.removed].sort(),
		},
		{ relaxed: false },
	);
}

const isNames = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((name) => typeof name === 'string');

function resumeOf(record: Document): Resume | undefined {
	const at = record['startAtOperationTime'];
	if (at instanceof BSON.Timestamp) return { startAtOperationTime: at };
	const after = record['startAfter'];
	if (isDocument(after)) return { startAfter: after };
	return undefined;
}

/** The position a backup recorded, or nothing when it is not one this version wrote. */
export function readPosition(text: string | undefined): Position | undefined {
	if (text === undefined) return undefined;
	let value: unknown;
	try {
		value = BSON.EJSON.parse(text, { relaxed: false });
	} catch {
		return undefined;
	}
	if (!isDocument(value) || value['format'] !== POSITION_FORMAT) {
		return undefined;
	}
	const resume = resumeOf(value);
	const { added, removed } = value;
	if (!resume || !isNames(added) || !isNames(removed)) return undefined;
	return { resume, added, removed };
}
