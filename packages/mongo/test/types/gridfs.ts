// What a bucket refuses to compile. Each `@ts-expect-error` is a mistake that
// must not get past the compiler: if one ever does compile, tsc reports the
// directive as unused and this file fails the typecheck.

import type { Db, ObjectId } from 'mongodb';
import { getFiles } from '../../src/gridfs';
import { avatars, uploads } from '../buckets';

declare const db: Db;
declare const id: ObjectId;
const photos = getFiles(db, avatars);
const anything = getFiles(db, uploads);

// --- the metadata a bucket describes -------------------------------------
await photos.put(new Blob(['a']), {
	metadata: { userId: id, width: 10, takenAt: new Date() },
});
// An id or a date may arrive as a string, here as everywhere else.
await photos.put(new Blob(['a']), {
	metadata: { userId: '68ca1f0f2b1c4d5e6f7a8b90', takenAt: '2026-01-01' },
});
// @ts-expect-error the schema has no such field
await photos.put(new Blob(['a']), { metadata: { nope: 1 } });
// @ts-expect-error `width` is a number
await photos.put(new Blob(['a']), { metadata: { userId: id, width: 'wide' } });
// @ts-expect-error a bucket with a required field needs it
await photos.put(new Blob(['a']), { metadata: {} });
// @ts-expect-error a number is not an id, and never becomes one
await photos.put(new Blob(['a']), { metadata: { userId: 42 } });

// A bucket that describes nothing takes anything.
await anything.put(new Blob(['a']), { metadata: { whatever: [1, 2, 3] } });

// --- what a read gives back ----------------------------------------------
const file = await photos.get(id);
const owner: ObjectId = file.metadata.userId;
const taken: Date | null = file.metadata.takenAt;
void owner;
void taken;
// @ts-expect-error the metadata is typed, so a misspelling is caught
void file.metadata.usrId;
// @ts-expect-error the type and the digest are not metadata fields
void file.metadata.contentType;

// --- the sources a write takes -------------------------------------------
await anything.put('a string');
await anything.put(new Uint8Array(1));
await anything.put(new ArrayBuffer(1));
await anything.put(new Response('a'));
await anything.put(new Blob(['a']).stream());
// @ts-expect-error a number is not a file
await anything.put(42);

// --- ids go in either form -----------------------------------------------
await anything.get('68ca1f0f2b1c4d5e6f7a8b90');
await anything.delete(id);
// @ts-expect-error a number is not an id
await anything.get(42);

// --- the options a bucket and a write take -------------------------------
getFiles(db, uploads, { autoSync: true, hash: false, validate: 'off' });
// @ts-expect-error there is no such option, and a typo must not be ignored
getFiles(db, uploads, { autosync: true });
await anything.put('a', {
	id,
	chunkSize: 1024,
	filename: 'a.txt',
	type: 'text/plain',
});
await anything.put('a', { id: '68ca1f0f2b1c4d5e6f7a8b90' });
// @ts-expect-error a chunk size is a number of bytes
await anything.put('a', { chunkSize: '1kb' });

// --- what a range is -----------------------------------------------------
await file.bytes({ start: 0, end: 10 });
file.response({ range: { start: 0 }, download: 'ada.png' });
// @ts-expect-error a range is bytes, not a string
await file.bytes({ start: '0' });
