import type { Since } from '@nxgt/backup';
import { MongoBackupError } from '../errors';
import { METADATA } from '../format/names';
import type { Position } from '../format/position';

/** The collections and views the chain's full backup holds: one metadata entry each. */
export function heldByFull(since: Since): Set<string> {
	const names = new Set<string>();
	for (const name of since.entries.keys()) {
		if (name.startsWith(METADATA)) names.add(name.slice(METADATA.length));
	}
	return names;
}

/** What the chain follows: its full backup's, changed as the position says. */
export function followedFrom(
	full: Set<string>,
	position: Position,
): Set<string> {
	const held = new Set([...full, ...position.added]);
	for (const name of position.removed) held.delete(name);
	return held;
}

/** How `held` differs from what the full backup holds, as a position records it. */
export function differenceOf(
	full: Set<string>,
	held: Set<string>,
): Pick<Position, 'added' | 'removed'> {
	return {
		added: [...held].filter((name) => !full.has(name)),
		removed: [...full].filter((name) => !held.has(name)),
	};
}

/** The most a position may hold: `@nxgt/backup`'s limit. */
export const POSITION_MAX_BYTES = 64 * 1024;

/** `text`, unless it is longer than a position may be. */
export function fitting(text: string): string {
	if (Buffer.byteLength(text) > POSITION_MAX_BYTES) {
		throw new MongoBackupError(
			'mongoSource: the collections created, renamed or dropped since the ' +
				'full backup are too many to record; make a full backup',
			'UNSUPPORTED',
		);
	}
	return text;
}
