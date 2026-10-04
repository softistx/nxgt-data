import { describe, expect, test } from 'bun:test';
import type { Since } from '@nxgt/backup';
import { BSON } from 'mongodb';
import { after } from './catalog';
import { followed } from './events';
import {
	differenceOf,
	fitting,
	followedFrom,
	heldByFull,
	POSITION_MAX_BYTES,
} from './followed';

const known = { size: 0, sha256: '', fingerprint: undefined };

describe('what a chain follows', () => {
	test('is its full backup’s metadata entries, changed by the position', () => {
		const since: Since = {
			id: 'x',
			position: undefined,
			entries: new Map([
				['metadata/a', known],
				['documents/a', known],
				['metadata/v', known],
				['changes/000001', known],
			]),
		};
		const full = heldByFull(since);
		expect([...full].sort()).toEqual(['a', 'v']);
		const held = followedFrom(full, {
			resume: { startAfter: {} },
			added: ['b'],
			removed: ['v'],
		});
		expect([...held].sort()).toEqual(['a', 'b']);
		held.delete('a');
		held.add('c');
		expect(differenceOf(full, held)).toEqual({
			added: ['b', 'c'],
			removed: ['a', 'v'],
		});
	});

	test('is refused once it no longer fits a position', () => {
		const most = 'x'.repeat(POSITION_MAX_BYTES);
		expect(fitting(most)).toBe(most);
		expect(() => fitting(`${most}é`)).toThrow(
			'mongoSource: the collections created, renamed or dropped since the ' +
				'full backup are too many to record; make a full backup',
		);
	});
});

describe('followed', () => {
	test('a dropped database leaves nothing followed, views included', () => {
		// mongod drops each collection first, but no view.
		const held = new Set(['a', 'v']);
		expect(followed({ op: 'dropDatabase' }, held, undefined)).toEqual({
			op: 'dropDatabase',
		});
		expect([...held]).toEqual([]);
	});
});

describe('after', () => {
	test('is the next cluster time, the increment carried over', () => {
		expect(after(new BSON.Timestamp({ t: 5, i: 7 }))).toEqual(
			new BSON.Timestamp({ t: 5, i: 8 }),
		);
		expect(after(new BSON.Timestamp({ t: 5, i: 0xffffffff }))).toEqual(
			new BSON.Timestamp({ t: 6, i: 0 }),
		);
	});
});
