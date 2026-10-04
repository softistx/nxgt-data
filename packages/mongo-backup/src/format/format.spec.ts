import { describe, expect, test } from 'bun:test';
import { BSON } from 'mongodb';
import { rejection } from '../../test/rejection';
import { bsonDocuments, DOCUMENT_MAX_BYTES } from './bson-stream';
import { type Change, readChange, writeChange } from './change';
import { readMetadata, writeMetadata } from './metadata';
import { changesName, parseName } from './names';
import { readPosition, writePosition } from './position';

/** A stream giving `bytes` in chunks of `size`. */
function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= bytes.length) return controller.close();
			controller.enqueue(bytes.slice(offset, offset + size));
			offset += size;
		},
	});
}

async function documents(stream: ReadableStream<Uint8Array>) {
	const found: unknown[] = [];
	for await (const raw of bsonDocuments(stream, 'here')) {
		found.push(BSON.deserialize(raw));
	}
	return found;
}

describe('bsonDocuments', () => {
	const written = [{ a: 1 }, { b: 'x'.repeat(300) }, {}, { c: [1, 2] }];
	const bytes = Buffer.concat(written.map((d) => BSON.serialize(d)));

	test('gives each document whole, however the chunks fall', async () => {
		for (const size of [1, 3, 4, 5, 7, 64, bytes.length]) {
			expect(await documents(chunked(bytes, size))).toEqual(written);
		}
		expect(await documents(chunked(new Uint8Array(0), 1))).toEqual([]);
	});

	test('refuses a stream ending inside a document, or a length that is not one', async () => {
		const length = (n: number) => {
			const b = new Uint8Array(4);
			new DataView(b.buffer).setInt32(0, n, true);
			return b;
		};
		for (const broken of [
			bytes.subarray(0, bytes.length - 1),
			bytes.subarray(0, 2),
			length(4),
			length(-1),
			length(DOCUMENT_MAX_BYTES + 1),
		]) {
			const error = await rejection(documents(chunked(broken, 3)));
			expect(error).toHaveProperty('code', 'MALFORMED');
			expect(error).toHaveProperty(
				'message',
				'here: an entry is not a sequence of BSON documents',
			);
		}
		// Refused as soon as the length is read, not once the stream ends:
		// this one never does.
		const huge = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(length(DOCUMENT_MAX_BYTES + 1));
			},
		});
		expect(await rejection(documents(huge))).toHaveProperty(
			'code',
			'MALFORMED',
		);
		const largest = length(DOCUMENT_MAX_BYTES);
		const error = await rejection(documents(chunked(largest, 4)));
		expect(error).toHaveProperty('code', 'MALFORMED');
	});
});

describe('names', () => {
	test('read what they write, and nothing else', () => {
		expect(parseName('metadata/a.b')).toEqual({
			kind: 'metadata',
			collection: 'a.b',
		});
		expect(parseName('documents/x')).toEqual({
			kind: 'documents',
			collection: 'x',
		});
		expect(parseName(changesName(12))).toEqual({
			kind: 'changes',
			sequence: 12,
		});
		expect(changesName(1)).toBe('changes/000001');
		for (const other of [
			'metadata/',
			'documents/',
			'changes/1',
			'changes/00001a',
			'changes/0000000001',
			'other/a',
		]) {
			expect(parseName(other)).toBeUndefined();
		}
	});
});

describe('position', () => {
	test('reads back what it wrote', () => {
		const at = new BSON.Timestamp({ t: 5, i: 7 });
		for (const resume of [
			{ startAtOperationTime: at },
			{ startAfter: { _data: '82ABC' } },
		]) {
			const position = { resume, added: ['b', 'a'], removed: ['d', 'c'] };
			expect(readPosition(writePosition(position))).toEqual({
				resume,
				added: ['a', 'b'],
				removed: ['c', 'd'],
			});
		}
	});

	test('reads nothing from what it did not write', () => {
		for (const text of [
			undefined,
			'',
			'[]',
			'null',
			'{"format":"other","startAfter":{}}',
			'{"format":"nxgt-mongo-backup-position/1"}',
			'{"format":"nxgt-mongo-backup-position/1","startAtOperationTime":5}',
			'{"format":"nxgt-mongo-backup-position/1","startAfter":[],"added":[],"removed":[]}',
			'{"format":"nxgt-mongo-backup-position/1","startAfter":{},"removed":[]}',
			'{"format":"nxgt-mongo-backup-position/1","startAfter":{},"added":[]}',
			'{"format":"nxgt-mongo-backup-position/1","startAfter":{},"added":[1],"removed":[]}',
			'{"format":"nxgt-mongo-backup-position/1","startAfter":{},"added":[],"removed":[1]}',
			'{"format":"nxgt-mongo-backup-position/1","startAfter":{"$numberInt":"1"}}',
		]) {
			expect(readPosition(text)).toBeUndefined();
		}
	});
});

describe('metadata', () => {
	test('reads back what it wrote, and nothing else', () => {
		const metadata = {
			type: 'collection' as const,
			options: { capped: true, size: new BSON.Int32(4096) },
			indexes: [{ name: 'a', key: { a: new BSON.Int32(1) } }],
		};
		expect(readMetadata(writeMetadata(metadata))).toEqual(metadata);
		const format = '"format":"nxgt-mongo-backup-metadata/1"';
		for (const text of [
			'x',
			'{}',
			`{${format},"type":"table","options":{},"indexes":[]}`,
			`{${format},"type":"view","options":[],"indexes":[]}`,
			`{${format},"type":"view","options":{},"indexes":{}}`,
			`{${format},"type":"view","options":{},"indexes":[{"key":{}}]}`,
		]) {
			expect(readMetadata(text)).toBeUndefined();
		}
	});
});

describe('changes', () => {
	test('read back what they wrote, number kinds kept', () => {
		const key = { _id: new BSON.Int32(1) };
		const changes: Change[] = [
			{ op: 'insert', coll: 'a', key, doc: { n: BSON.Long.fromNumber(2) } },
			{ op: 'replace', coll: 'a', key, doc: { n: new BSON.Double(2) } },
			{
				op: 'update',
				coll: 'a',
				key,
				set: { 'b.c': new BSON.Int32(1) },
				unset: ['d'],
				truncated: [{ field: 'e', newSize: 2 }],
			},
			{ op: 'delete', coll: 'a', key },
			{ op: 'create', coll: 'a', options: { capped: true } },
			{
				op: 'createIndexes',
				coll: 'a',
				indexes: [{ name: 'i', key: { i: new BSON.Int32(1) } }],
			},
			{ op: 'dropIndexes', coll: 'a', names: ['i'] },
			{ op: 'modify', coll: 'a', changes: { validator: {} } },
			{ op: 'drop', coll: 'a' },
			{ op: 'rename', coll: 'a', to: 'b', dropTarget: false },
			{ op: 'dropDatabase' },
		];
		for (const change of changes) {
			expect(readChange(writeChange(change))).toEqual(change);
		}
	});

	test('read nothing from a record this version did not write', () => {
		for (const record of [
			{ op: 'insert' },
			{ op: 'insert', coll: '' },
			{ op: 'insert', coll: 'a', key: {} },
			{ op: 'insert', coll: 'a', doc: {} },
			{ op: 'update', coll: 'a', key: {}, set: {}, unset: [1], truncated: [] },
			{ op: 'update', coll: 'a', key: {}, set: [], unset: [], truncated: [] },
			{ op: 'update', coll: 'a', key: {}, set: {}, unset: [], truncated: {} },
			{
				op: 'update',
				coll: 'a',
				key: {},
				set: {},
				unset: [],
				truncated: [{ field: 'x', newSize: 'y' }],
			},
			{
				op: 'update',
				coll: 'a',
				key: {},
				set: {},
				unset: [],
				truncated: [{ newSize: 1 }],
			},
			{ op: 'delete', coll: 'a' },
			{ op: 'create', coll: 'a' },
			{ op: 'createIndexes', coll: 'a', indexes: [1] },
			{ op: 'dropIndexes', coll: 'a', names: [1] },
			{ op: 'modify', coll: 'a', changes: [] },
			{ op: 'rename', coll: 'a' },
			{ op: 'rename', coll: 'a', to: 'b' },
			{ op: 'other', coll: 'a' },
		]) {
			expect(readChange(BSON.serialize(record))).toBeUndefined();
		}
	});
});
