import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Binary, GridFSBucket, ObjectId } from 'mongodb';
import { avatars, clips, uploads } from '../../test/buckets';
import { startMongo, type TestServer } from '../../test/server';
import {
	ConflictError,
	CorruptFileError,
	NotFoundError,
} from '../errors/data-error';
import { withTransaction } from '../transaction/with-transaction';
import { defineBucket } from './define-bucket';
import { getFiles } from './get-files';
import { resetBucketSync } from './indexes';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo();
}, 120_000);
beforeEach(async () => {
	// The database goes, so the memo of what `autoSync` has already created
	// has to go with it.
	resetBucketSync();
	await t.reset();
});
afterAll(() => t.stop());

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const photos = () => getFiles(t.db, avatars);
const anything = () => getFiles(t.db, uploads);

describe('writing a file', () => {
	test('stores the bytes, and reads them back whole', async () => {
		const files = anything();
		const file = await files.put(bytes(2048));
		expect(file.size).toBe(2048);
		expect(await file.bytes()).toEqual(bytes(2048));
		expect(file.id).toHaveLength(24);
		expect(file.uploadDate).toBeInstanceOf(Date);
	});

	test('takes the type and the name a `Bun.file` carries, with no option', async () => {
		const dir = `${tmpdir()}/nxgt-gridfs-${Bun.randomUUIDv7()}`;
		const path = `${dir}/ada.png`;
		await Bun.write(path, bytes(64));
		const file = await anything().put(Bun.file(path));
		// `Bun.file('/a/b/ada.png')` reports the whole **path** as its name and
		// `image/png` as its type — measured on bun 1.4.2. A stored filename is
		// a name, never a path.
		expect(file.filename).toBe('ada.png');
		expect(file.type).toBe('image/png');
		await rm(dir, { recursive: true, force: true });
	});

	test('lets the caller name the type and the file', async () => {
		const file = await anything().put('a,b\n', {
			filename: 'report.csv',
			type: 'text/csv',
		});
		expect(file.filename).toBe('report.csv');
		expect(file.type).toBe('text/csv');
		expect(await file.text()).toBe('a,b\n');
	});

	test('writes a string in bytes, not in characters', async () => {
		const file = await anything().put('héllo 🌍');
		expect(file.size).toBe(Buffer.byteLength('héllo 🌍', 'utf8'));
		expect(await file.text()).toBe('héllo 🌍');
	});

	test('reads every source shape', async () => {
		const files = anything();
		const blob = await files.put(new Blob([bytes(10) as BlobPart]));
		const buffer = await files.put(bytes(11).buffer);
		const view = await files.put(bytes(12));
		const response = await files.put(
			new Response('hello', { headers: { 'content-type': 'text/plain' } }),
		);
		const stream = await files.put(new Blob([bytes(13) as BlobPart]).stream());
		expect([blob.size, buffer.size, view.size, stream.size]).toEqual([
			10, 11, 12, 13,
		]);
		// A `Response` knows its own type, exactly as a `Blob` does.
		expect(response.type).toBe('text/plain');
	});

	test('refuses a source it cannot read', async () => {
		const files = anything();
		await expect(files.put(42 as never)).rejects.toThrow(/expected a file/);
		const drained = new Response('a');
		await drained.text();
		await expect(files.put(drained)).rejects.toThrow(/no body/);
	});

	test('takes an `_id` the caller chose, in either form', async () => {
		const chosen = new ObjectId();
		const files = anything();
		const file = await files.put(bytes(4), { id: chosen.toHexString() });
		expect(file._id).toEqual(chosen);
	});
});

describe('the metadata a bucket describes', () => {
	test('checks it, and reads the strings as what they are', async () => {
		const userId = new ObjectId();
		const file = await photos().put(bytes(8), {
			// A 24-hex string on an `objectId()` field, as everywhere else here.
			metadata: { userId: userId.toHexString(), width: 128 },
		});
		expect(file.metadata.userId).toEqual(userId);
		expect(file.metadata.width).toBe(128);
		// The schema's own default is filled, as a create's would be.
		expect(file.metadata.takenAt).toBe(null);
	});

	test('refuses metadata the schema refuses', async () => {
		const files = photos();
		await expect(
			files.put(bytes(8), { metadata: {} as never }),
		).rejects.toThrow();
		await expect(
			files.put(bytes(8), {
				metadata: { userId: new ObjectId(), width: 0 } as never,
			}),
		).rejects.toThrow();
	});

	test('keeps the type and the digest out of the metadata it gives back', async () => {
		const file = await photos().put(bytes(8), {
			metadata: { userId: new ObjectId() },
			type: 'image/png',
		});
		expect(Object.keys(file.metadata).sort()).toEqual(['takenAt', 'userId']);
		expect(file.type).toBe('image/png');
		expect(file.sha256).toHaveLength(64);
	});

	test('refuses a caller who writes those two by hand', async () => {
		await expect(
			anything().put(bytes(8), { metadata: { contentType: 'text/plain' } }),
		).rejects.toThrow(/kept by "uploads" itself/);
		// `validate: 'off'` is about the schema, and these two are not the
		// schema's: the refusal comes before anything is parsed.
		await expect(
			getFiles(t.db, uploads, { validate: 'off' }).put(bytes(8), {
				metadata: { sha256: 'deadbeef' },
			}),
		).rejects.toThrow(/kept by "uploads" itself/);
	});

	test('lets anything through when the bucket describes nothing', async () => {
		const file = await anything().put(bytes(8), {
			metadata: { whatever: [1, 2, 3] },
		});
		expect(file.metadata).toEqual({ whatever: [1, 2, 3] });
	});
});

describe('finding a file', () => {
	test('gives a handle that has read no bytes', async () => {
		const files = anything();
		const written = await files.put(bytes(4096), { type: 'image/png' });
		const found = await files.get(written.id);
		expect(found.size).toBe(4096);
		expect(found.type).toBe('image/png');
		expect(found.chunkSize).toBeGreaterThan(0);
	});

	test('answers for a file that is not there', async () => {
		const files = anything();
		const missing = new ObjectId();
		expect(await files.find(missing)).toBeUndefined();
		expect(await files.exists(missing)).toBe(false);
		await expect(files.get(missing)).rejects.toBeInstanceOf(NotFoundError);
	});

	test('refuses an id that is not one', async () => {
		await expect(anything().get('not-an-id')).rejects.toThrow();
	});
});

describe('reading part of a file', () => {
	test('reads a range that spans several chunks', async () => {
		const files = getFiles(t.db, clips);
		const payload = new Uint8Array(4096).map((_, i) => i % 251);
		const file = await files.put(payload);
		expect(file.chunkSize).toBe(1024);
		// `end` is exclusive, as `openDownloadStream` reads it — measured.
		const middle = await file.bytes({ start: 1000, end: 3000 });
		expect(middle).toEqual(payload.slice(1000, 3000));
	});

	test('reads to the end when only a start is given', async () => {
		const files = getFiles(t.db, clips);
		const payload = new Uint8Array(3000).map((_, i) => i % 97);
		const file = await files.put(payload);
		expect(await file.bytes({ start: 2990 })).toEqual(payload.slice(2990));
	});
});

describe('serving a file over HTTP', () => {
	async function served(range?: string, headers: HeadersInit = {}) {
		const files = getFiles(t.db, clips);
		const payload = new Uint8Array(4096).map((_, i) => i % 251);
		const file = await files.put(payload, {
			filename: 'clip.bin',
			type: 'video/mp4',
		});
		const request = new Request('http://x/f', {
			headers: { ...(range ? { range } : {}), ...headers },
		});
		return { file, payload, response: await files.serve(request, file.id) };
	}

	test('answers the whole file with 200', async () => {
		const { response, payload } = await served();
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('video/mp4');
		expect(response.headers.get('content-length')).toBe('4096');
		expect(response.headers.get('accept-ranges')).toBe('bytes');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
	});

	test('answers a range with 206 and the bytes it names', async () => {
		const { response, payload } = await served('bytes=100-199');
		expect(response.status).toBe(206);
		expect(response.headers.get('content-range')).toBe('bytes 100-199/4096');
		expect(response.headers.get('content-length')).toBe('100');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(
			payload.slice(100, 200),
		);
	});

	test('answers 416 for a range past the end, naming the size', async () => {
		const { response } = await served('bytes=99999-');
		expect(response.status).toBe(416);
		expect(response.headers.get('content-range')).toBe('bytes */4096');
	});

	test('answers 304 when the caller already has the bytes', async () => {
		const first = await served();
		const etag = first.response.headers.get('etag');
		expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
		const files = getFiles(t.db, clips);
		const again = await files.serve(
			new Request('http://x/f', { headers: { 'if-none-match': etag ?? '' } }),
			first.file.id,
		);
		expect(again.status).toBe(304);
	});

	test('answers 404 rather than throwing', async () => {
		const response = await getFiles(t.db, clips).serve(
			new Request('http://x/f'),
			new ObjectId(),
		);
		expect(response.status).toBe(404);
	});

	test('names the download when asked, and escapes what it must', async () => {
		const files = anything();
		const file = await files.put(bytes(4), { filename: 'rapport «été».pdf' });
		const response = (await files.get(file.id)).response({ download: true });
		const disposition = response.headers.get('content-disposition') ?? '';
		// The plain form is ASCII and quotable; the starred one carries the name.
		expect(disposition).toContain('attachment; filename="rapport __t__.pdf"');
		expect(disposition).toContain(
			`filename*=UTF-8''${encodeURIComponent('rapport «été».pdf')}`,
		);
	});
});

describe('writing a file only once', () => {
	test('gives back the file that was already there', async () => {
		const files = anything();
		const first = await files.putOnce(bytes(2048));
		const again = await files.putOnce(bytes(2048));
		expect(first.stored).toBe(true);
		expect(again.stored).toBe(false);
		expect(again.file._id).toEqual(first.file._id);
		expect(await files.paginate()).toMatchObject({ nextCursor: null });
		expect((await files.paginate()).items).toHaveLength(1);
	});

	test('a source that can only be read once is written, then compared', async () => {
		const files = anything();
		await files.putOnce(bytes(512));
		// A stream cannot be rewound, so this one is uploaded and the copy is
		// removed once the digests are seen to match.
		const again = await files.putOnce(
			new Blob([bytes(512) as BlobPart]).stream(),
		);
		expect(again.stored).toBe(false);
		expect((await files.paginate()).items).toHaveLength(1);
		expect(await t.db.collection('uploads.chunks').countDocuments()).toBe(1);
	});

	test('different bytes are a different file', async () => {
		const files = anything();
		const a = await files.putOnce(bytes(512, 1));
		const b = await files.putOnce(bytes(512, 2));
		expect(b.stored).toBe(true);
		expect(b.file._id).not.toEqual(a.file._id);
	});

	test('refuses to guess when the bucket keeps no digest', async () => {
		const files = getFiles(t.db, uploads, { hash: false });
		await expect(files.putOnce(bytes(8))).rejects.toThrow(/nothing to compare/);
	});
});

describe('listing a bucket', () => {
	test('pages newest first, and the cursor reaches every file', async () => {
		const files = anything();
		for (let i = 0; i < 5; i++)
			await files.put(bytes(8, i), { filename: `f${i}` });
		const first = await files.paginate({ limit: 2 });
		expect(first.items.map((f) => f.filename)).toEqual(['f4', 'f3']);
		const second = await files.paginate({ limit: 2, after: first.nextCursor });
		expect(second.items.map((f) => f.filename)).toEqual(['f2', 'f1']);
		const third = await files.paginate({ limit: 2, after: second.nextCursor });
		expect(third.items.map((f) => f.filename)).toEqual(['f0']);
		expect(third.nextCursor).toBeNull();
	});

	test('pages oldest first when asked', async () => {
		const files = anything();
		for (let i = 0; i < 3; i++)
			await files.put(bytes(8, i), { filename: `f${i}` });
		const page = await files.paginate({ order: 'oldest', limit: 2 });
		expect(page.items.map((f) => f.filename)).toEqual(['f0', 'f1']);
	});

	test('filters on the metadata, reading its strings too', async () => {
		const files = photos();
		const mine = new ObjectId();
		await files.put(bytes(8), { metadata: { userId: mine } });
		await files.put(bytes(9), { metadata: { userId: new ObjectId() } });
		const page = await files.paginate({
			filter: { 'metadata.userId': mine.toHexString() },
		});
		expect(page.items).toHaveLength(1);
		expect(page.items[0]?.size).toBe(8);
	});

	test('refuses a cursor written for the other order', async () => {
		const files = anything();
		await files.put(bytes(8));
		await files.put(bytes(9));
		const page = await files.paginate({ limit: 1 });
		await expect(
			files.paginate({ limit: 1, order: 'oldest', after: page.nextCursor }),
		).rejects.toThrow(/ordering/);
	});
});

describe('removing and renaming', () => {
	test('takes the chunks with the file', async () => {
		const files = getFiles(t.db, clips);
		const file = await files.put(new Uint8Array(4096));
		expect(await t.db.collection('clips.chunks').countDocuments()).toBe(4);
		await files.delete(file.id);
		expect(await files.exists(file.id)).toBe(false);
		expect(await t.db.collection('clips.chunks').countDocuments()).toBe(0);
	});

	test('says so when there is nothing to remove or rename', async () => {
		const files = anything();
		const missing = new ObjectId();
		await expect(files.delete(missing)).rejects.toBeInstanceOf(NotFoundError);
		await expect(files.rename(missing, 'a')).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});

	test('renames without touching the bytes', async () => {
		const files = anything();
		const file = await files.put(bytes(16), { filename: 'old.txt' });
		await files.rename(file.id, 'new.txt');
		const found = await files.get(file.id);
		expect(found.filename).toBe('new.txt');
		expect(await found.bytes()).toEqual(bytes(16));
	});
});

describe('the indexes a bucket reads through', () => {
	test('creates them, and says so only the first time', async () => {
		const files = anything();
		const first = await files.syncIndexes();
		expect(first.flatMap((r) => r.created)).toEqual([
			'nxgt_uploadDate_id',
			'nxgt_sha256',
			'filename_1_uploadDate_1',
			'files_id_1_n_1',
		]);
		const again = await files.syncIndexes();
		expect(again.flatMap((r) => r.created)).toEqual([]);
		expect(again.flatMap((r) => r.existing)).toHaveLength(4);
	});
});

describe('the options a bound bucket takes', () => {
	test('without parsing, the metadata is sent as it was given', async () => {
		const files = getFiles(t.db, avatars, { validate: 'off' });
		const file = await files.put(bytes(8), {
			// No `userId`, which the schema requires: nothing checks it here.
			metadata: { width: 10 } as never,
		});
		expect(file.metadata as unknown).toEqual({ width: 10 });
	});

	test('without coercion, a string stays a string', async () => {
		const files = getFiles(t.db, avatars, { coerce: false, validate: 'off' });
		const id = new ObjectId().toHexString();
		const file = await files.put(bytes(8), {
			metadata: { userId: id } as never,
		});
		expect(file.metadata.userId as unknown).toBe(id);
	});

	test('without hashing, there is no digest and no ETag', async () => {
		const files = getFiles(t.db, uploads, { hash: false });
		const file = await files.put(bytes(8));
		expect(file.sha256).toBeUndefined();
		const response = file.response();
		expect(response.headers.get('etag')).toBeNull();
		expect(await file.bytes()).toEqual(bytes(8));
	});
});

describe('a bucket in a transaction', () => {
	test('writes nothing when the transaction rolls back', async () => {
		const files = anything();
		await expect(
			withTransaction(t.client, async (session) => {
				await files.withSession(session).put(bytes(2048));
				throw new Error('rolled back');
			}),
		).rejects.toThrow('rolled back');
		expect((await files.paginate()).items).toEqual([]);
		expect(await t.db.collection('uploads.chunks').countDocuments()).toBe(0);
	});

	test('takes a delete back with it, chunks included', async () => {
		const files = anything();
		const file = await files.put(bytes(2048));
		await expect(
			withTransaction(t.client, async (session) => {
				await files.withSession(session).delete(file.id);
				throw new Error('rolled back');
			}),
		).rejects.toThrow('rolled back');
		// `GridFSBucket.delete` takes no session in mongodb 7.6, so this
		// package does the two deletes itself — which is what makes them
		// part of the transaction.
		expect(await files.exists(file.id)).toBe(true);
		expect(await (await files.get(file.id)).bytes()).toEqual(bytes(2048));
	});
});

describe('an upload that fails halfway', () => {
	test('leaves neither a file nor its chunks', async () => {
		const files = getFiles(t.db, clips);
		// The failure has to come while the stream is being **pulled**: a
		// stream that errors in `start` is read not once, so nothing was ever
		// written and there would be nothing to clean up. Measured: without
		// the cleanup this leaves 32 chunks behind, two batches of sixteen.
		let sent = 0;
		const failing = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent >= 40) {
					controller.error(new Error('the source gave up'));
					return;
				}
				sent += 1;
				controller.enqueue(new Uint8Array(1024).fill(sent));
			},
		});
		await expect(files.put(failing)).rejects.toThrow(/gave up/);
		expect(await t.db.collection('clips.files').countDocuments()).toBe(0);
		expect(await t.db.collection('clips.chunks').countDocuments()).toBe(0);
	});
});

describe('a file whose chunks are not all there', () => {
	test('says so while reading, not while finding', async () => {
		const files = getFiles(t.db, clips);
		const file = await files.put(new Uint8Array(4096));
		await t.db
			.collection('clips.chunks')
			.deleteOne({ files_id: file._id, n: 2 });
		// Nothing ties the two collections together in MongoDB, so a file can
		// be found whole and read short. Finding it still works.
		const found = await files.get(file.id);
		expect(found.size).toBe(4096);
		await expect(found.bytes()).rejects.toBeInstanceOf(CorruptFileError);
		await expect(found.bytes()).rejects.toThrow(/Chunk 2 .* is missing/);
	});

	test('a range that does not span the hole still reads', async () => {
		const files = getFiles(t.db, clips);
		const payload = new Uint8Array(4096).map((_, i) => i % 251);
		const file = await files.put(payload);
		await t.db
			.collection('clips.chunks')
			.deleteOne({ files_id: file._id, n: 3 });
		const found = await files.get(file.id);
		expect(await found.bytes({ start: 0, end: 1024 })).toEqual(
			payload.slice(0, 1024),
		);
	});
});

describe('the bytes a chunk boundary falls on', () => {
	test('cuts at exactly the chunk size, and stores no empty tail', async () => {
		const files = getFiles(t.db, clips);
		const file = await files.put(new Uint8Array(2048));
		// 2048 bytes at 1024 a chunk is two chunks, not three.
		expect(await t.db.collection('clips.chunks').countDocuments()).toBe(2);
		expect(file.size).toBe(2048);
	});

	test('a file of no bytes has no chunks at all', async () => {
		const files = getFiles(t.db, clips);
		const file = await files.put(new Uint8Array(0));
		expect(file.size).toBe(0);
		expect(await t.db.collection('clips.chunks').countDocuments()).toBe(0);
		expect(await file.bytes()).toEqual(new Uint8Array(0));
		expect(file.response().headers.get('content-length')).toBe('0');
	});

	test('reassembles a source that arrives in pieces of its own', async () => {
		const files = getFiles(t.db, clips);
		const payload = new Uint8Array(5000).map((_, i) => i % 251);
		async function* trickle() {
			// Pieces that line up with no chunk boundary at all.
			for (let at = 0; at < payload.length; at += 333) {
				yield payload.subarray(at, Math.min(at + 333, payload.length));
			}
		}
		const file = await files.put(trickle());
		expect(file.size).toBe(5000);
		expect(await file.bytes()).toEqual(payload);
	});
});

describe('the edges the mutants found', () => {
	test('says so when it is the last chunks that are missing', async () => {
		const files = getFiles(t.db, clips);
		const file = await files.put(new Uint8Array(4096));
		// The cursor simply ends early here, rather than skipping a number:
		// a different branch from a hole in the middle, and the same answer.
		await t.db
			.collection('clips.chunks')
			.deleteOne({ files_id: file._id, n: 3 });
		await expect((await files.get(file.id)).bytes()).rejects.toBeInstanceOf(
			CorruptFileError,
		);
	});

	test('a source with no type of its own stores none', async () => {
		// `new Blob(['a']).type` is the empty string, not `undefined` —
		// measured — and an empty content type is not a content type.
		const file = await anything().put(new Blob(['a']));
		expect(file.type).toBeUndefined();
		expect(file.response().headers.get('content-type')).toBeNull();
	});

	test('pages through files that share an upload date', async () => {
		const files = anything();
		for (let i = 0; i < 3; i++)
			await files.put(bytes(8, i), { filename: `f${i}` });
		// The same millisecond for all three: `uploadDate` alone cannot order
		// them, so the cursor carries `_id` as well.
		const at = new Date('2026-01-01T00:00:00.000Z');
		await t.db
			.collection('uploads.files')
			.updateMany({}, { $set: { uploadDate: at } });
		const seen: string[] = [];
		let after: string | null | undefined;
		do {
			const page = await files.paginate({ limit: 2, after });
			seen.push(...page.items.map((f) => f.filename));
			after = page.nextCursor;
		} while (after);
		expect(seen.sort()).toEqual(['f0', 'f1', 'f2']);
	});
});

describe('a file written under an id that is already taken', () => {
	test('is refused, and the stored file keeps its bytes', async () => {
		const files = anything();
		const first = await files.put(bytes(70, 1), { chunkSize: 7 });
		const failed = await files
			.put(bytes(70, 2), { id: first._id, chunkSize: 7 })
			.catch((error: unknown) => error);
		expect(failed).toBeInstanceOf(ConflictError);
		expect((failed as Error).message).toMatch(/already has a file with _id/);
		// The point of the refusal: before it, the second write laid its ten
		// chunks down, failed on the `files` document, and then cleaned up by
		// `files_id` — taking the **first** file's bytes with it. The file was
		// still found, and read as a `CorruptFileError`.
		expect(await (await files.get(first.id)).bytes()).toEqual(bytes(70, 1));
	});

	test('a write that fails removes its own chunks and no others', async () => {
		const files = anything();
		const kept = await files.put(bytes(70, 1), { chunkSize: 7 });
		// A chunk of a file that does not exist, under an id nothing claims:
		// the unique `{ files_id, n }` index makes the write fail partway.
		await files.syncIndexes();
		const id = new ObjectId();
		await t.db
			.collection('uploads.chunks')
			.insertOne({ files_id: id, n: 3, data: new Binary(bytes(7)) });
		await expect(files.put(bytes(70, 2), { id, chunkSize: 7 })).rejects.toThrow(
			ConflictError,
		);
		expect(await (await files.get(kept.id)).bytes()).toEqual(bytes(70, 1));
		// Its own chunks are gone; the one that was there before it is not.
		expect(
			await t.db.collection('uploads.chunks').countDocuments({ files_id: id }),
		).toBe(1);
	});

	test('a failed chunk delete names the chunks collection too', async () => {
		const files = anything();
		const file = await files.put(bytes(70), { chunkSize: 7 });
		await t.db.collection('uploads.chunks').drop();
		await t.db.collection('source').insertOne({ a: 1 });
		// A view refuses a delete, so the second of `removeFile`'s two deletes
		// fails while the first has already worked.
		await t.db.createCollection('uploads.chunks', {
			viewOn: 'source',
			pipeline: [],
		});
		const failed = await files.delete(file.id).catch((error: unknown) => error);
		expect((failed as { collection?: string }).collection).toBe(
			'uploads.chunks',
		);
	});

	test('names the collection the failure actually happened on', async () => {
		const files = anything();
		await files.syncIndexes();
		const id = new ObjectId();
		await t.db
			.collection('uploads.chunks')
			.insertOne({ files_id: id, n: 0, data: new Binary(bytes(7)) });
		const failed = await files
			.put(bytes(70), { id, chunkSize: 7 })
			.catch((error: unknown) => error);
		// A bucket is two collections, and an error that says `.files` when the
		// write failed on `.chunks` sends whoever greps for it to the wrong one.
		expect((failed as ConflictError).collection).toBe('uploads.chunks');
	});
});

describe('two callers storing the same bytes at once', () => {
	test('keep exactly one copy, and agree on which', async () => {
		const files = anything();
		// A `Uint8Array` is read once, so both calls upload and then reconcile
		// — the path where "remove the copy that is not mine" loses the file
		// outright: each call found the other, each removed itself, and the
		// bucket ended up empty while both were told the bytes were safe.
		const [one, other] = await Promise.all([
			files.putOnce(bytes(4096)),
			files.putOnce(bytes(4096)),
		]);
		expect(one.file.id).toBe(other.file.id);
		expect([one.stored, other.stored].filter(Boolean)).toHaveLength(1);
		expect((await files.paginate()).items).toHaveLength(1);
		expect(await (await files.get(one.file.id)).bytes()).toEqual(bytes(4096));
	});

	test('a `Blob` reconciles too, rather than storing twice', async () => {
		const files = anything();
		// The check-then-write path cannot see a file whose `files` document
		// has not been written yet, so it ends in the same reconciliation.
		const [one, other] = await Promise.all([
			files.putOnce(new Blob([bytes(2048) as BlobPart])),
			files.putOnce(new Blob([bytes(2048) as BlobPart])),
		]);
		expect(one.file.id).toBe(other.file.id);
		expect((await files.paginate()).items).toHaveLength(1);
	});

	test('three at once leave one, not none', async () => {
		const files = anything();
		const all = await Promise.all([
			files.putOnce(bytes(3000)),
			files.putOnce(bytes(3000)),
			files.putOnce(bytes(3000)),
		]);
		expect(new Set(all.map((r) => r.file.id)).size).toBe(1);
		expect((await files.paginate()).items).toHaveLength(1);
	});
});

describe('a chunk that is there but short', () => {
	test('reads as a `CorruptFileError`, not as a short file', async () => {
		const files = anything();
		const file = await files.put(bytes(70), { chunkSize: 7 });
		await t.db
			.collection('uploads.chunks')
			.updateOne(
				{ files_id: file._id, n: 5 },
				{ $set: { data: new Binary(bytes(3)) } },
			);
		// Chunk numbers alone cannot catch this: nothing is missing, so there
		// is no gap. Without counting the bytes the read came back quietly
		// four bytes short, which is a truncated image the caller never hears
		// about.
		const found = await files.get(file.id);
		await expect(found.bytes()).rejects.toBeInstanceOf(CorruptFileError);
		await expect(found.bytes()).rejects.toThrow(/reads 66 bytes where/);
	});

	test('a truncated last chunk is caught too', async () => {
		const files = anything();
		const file = await files.put(bytes(70), { chunkSize: 7 });
		await t.db
			.collection('uploads.chunks')
			.updateOne(
				{ files_id: file._id, n: 9 },
				{ $set: { data: new Binary(bytes(3)) } },
			);
		await expect((await files.get(file.id)).bytes()).rejects.toBeInstanceOf(
			CorruptFileError,
		);
	});
});

describe('the indexes, and the session they run in', () => {
	test('`autoSync` creates them before the first call that needs them', async () => {
		const files = getFiles(t.db, uploads, { autoSync: true });
		await files.put(bytes(16));
		// Nothing else creates these: the driver made two of them on its first
		// upload, and this package stopped uploading through the driver.
		const chunks = (await t.db.collection('uploads.chunks').indexes()).map(
			(index) => index.name,
		);
		expect(chunks).toContain('files_id_1_n_1');
		const stored = (await t.db.collection('uploads.files').indexes()).map(
			(index) => index.name,
		);
		expect(stored).toContain('nxgt_uploadDate_id');
	});

	test('without it, nothing creates them', async () => {
		await anything().put(bytes(16));
		const chunks = (await t.db.collection('uploads.chunks').indexes()).map(
			(index) => index.name,
		);
		expect(chunks).toEqual(['_id_']);
	});

	test('a bucket bound to a session stays an `autoSync` one', async () => {
		const files = getFiles(t.db, uploads, { autoSync: true });
		await withTransaction(t.client, async (session) => {
			await files.withSession(session).put(bytes(16));
		});
		const chunks = (await t.db.collection('uploads.chunks').indexes()).map(
			(index) => index.name,
		);
		expect(chunks).toContain('files_id_1_n_1');
	});

	test('a failure that is not "no such collection" is raised', async () => {
		await t.db.collection('source').insertOne({ a: 1 });
		// A view answers `listIndexes` with code 166, not 26. Swallowing every
		// error read that as "this bucket has no indexes" and went on to try to
		// build all four — the same shape as the `drop()` catch-all.
		await t.db.createCollection('viewed.files', {
			viewOn: 'source',
			pipeline: [],
		});
		await expect(
			getFiles(t.db, defineBucket({ name: 'viewed' })).syncIndexes(),
		).rejects.toThrow(/is a view, not a collection/);
	});

	test('`syncIndexes` runs in the session, so a transaction refuses it', async () => {
		const files = anything();
		// Measured: mongod will not create a namespace inside a transaction.
		// That refusal is the point — without the session the call escaped the
		// transaction silently and built the indexes anyway.
		const failed = await withTransaction(t.client, async (session) => {
			await files.withSession(session).syncIndexes();
		}).catch((error: unknown) => error);
		expect(failed).toBeInstanceOf(Error);
		expect(
			await t.db.listCollections({ name: 'uploads.files' }).toArray(),
		).toEqual([]);
	});

	test('and refuses it on collections that already exist too', async () => {
		const files = anything();
		await files.put(bytes(16));
		// Measured: "Cannot create new indexes on existing collection … in a
		// multi-document transaction" — so there is no case where this quietly
		// works, which is why `autoSync` drops the session before it runs.
		const failed = await withTransaction(t.client, async (session) => {
			await files.withSession(session).syncIndexes();
		}).catch((error: unknown) => error);
		expect(failed).toBeInstanceOf(Error);
		const stored = (await t.db.collection('uploads.files').indexes()).map(
			(index) => index.name,
		);
		expect(stored).toEqual(['_id_']);
	});
});

describe('dropping a bucket', () => {
	test('removes both collections', async () => {
		const files = anything();
		await files.put(bytes(2048));
		await files.drop();
		expect(await t.db.collection('uploads.files').countDocuments()).toBe(0);
		expect(await t.db.collection('uploads.chunks').countDocuments()).toBe(0);
	});

	test('a bucket that was never written to is not an error', async () => {
		await anything().drop();
	});

	test('a drop the server refuses is raised, not swallowed', async () => {
		const files = anything();
		await files.put(bytes(2048));
		// mongod refuses a `drop` inside a transaction. Catching every error
		// made a refused drop indistinguishable from one that worked — and the
		// files are still there either way.
		await expect(
			withTransaction(t.client, async (session) => {
				await files.withSession(session).drop();
			}),
		).rejects.toThrow();
		expect(await t.db.collection('uploads.files').countDocuments()).toBe(1);
	});
});

describe('an id that could not name a file', () => {
	test('is a 404 and not a 500, as it is on a collection', async () => {
		const files = anything();
		// The README offers `files.serve(c.req.raw, c.req.param('id'))` as a
		// route: a junk path parameter must not be a 500 on an unauthenticated
		// request. The rule across this package is that reading a string never
		// throws.
		const answer = await files.serve(
			new Request('http://x/files/nope'),
			'not-an-id',
		);
		expect(answer.status).toBe(404);
		expect(await files.find('not-an-id')).toBeUndefined();
		expect(await files.exists('not-an-id')).toBe(false);
		await expect(files.get('not-an-id')).rejects.toBeInstanceOf(NotFoundError);
		await expect(files.delete('not-an-id')).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});
});

describe('the headers a handler of its own puts on an answer', () => {
	test('ride on every status, not only on the ones with a body', async () => {
		const files = anything();
		const file = await files.put(bytes(70));
		const init = { headers: { 'cache-control': 'private, max-age=60' } };
		const cached = await files.serve(
			new Request('http://x/f', {
				headers: { 'if-none-match': `"${file.sha256}"` },
			}),
			file.id,
			init,
		);
		expect(cached.status).toBe(304);
		expect(cached.headers.get('cache-control')).toBe('private, max-age=60');
		const refused = await files.serve(
			new Request('http://x/f', { headers: { range: 'bytes=900-' } }),
			file.id,
			init,
		);
		expect(refused.status).toBe(416);
		expect(refused.headers.get('cache-control')).toBe('private, max-age=60');
		const missing = await files.serve(
			new Request('http://x/f'),
			new ObjectId(),
			init,
		);
		expect(missing.status).toBe(404);
		expect(missing.headers.get('cache-control')).toBe('private, max-age=60');
	});
});

describe('a range a file cannot satisfy', () => {
	test('is a 416, not a `Content-Range` no client can read', async () => {
		const file = await anything().put(bytes(70));
		// `parseRange` guards `serve`, but `response({ range })` is public and
		// took whatever it was given: past the end it answered `206` with
		// `content-range: bytes 200-69/70` and a body of nothing.
		const past = file.response({ range: { start: 200, end: 300 } });
		expect(past.status).toBe(416);
		expect(past.headers.get('content-range')).toBe('bytes */70');
		const backwards = file.response({ range: { start: 50, end: 10 } });
		expect(backwards.status).toBe(416);
	});

	test('a range that ends past the end is clamped, not refused', async () => {
		const file = await anything().put(bytes(70));
		const answer = file.response({ range: { start: 60, end: 400 } });
		expect(answer.status).toBe(206);
		expect(answer.headers.get('content-range')).toBe('bytes 60-69/70');
		expect(answer.headers.get('content-length')).toBe('10');
	});
});

describe('files this package and the driver both read', () => {
	test("a file written here is read by the driver's own bucket", async () => {
		const files = anything();
		const payload = new Uint8Array(600 * 1024).map((_, i) => i % 251);
		const file = await files.put(payload, { filename: 'clip.bin' });
		const driver = new GridFSBucket(t.db, { bucketName: 'uploads' });
		const read = await new Response(
			driver.openDownloadStream(file._id) as unknown as ReadableStream,
		).bytes();
		expect(read).toEqual(payload);
	});

	test('a file written by the driver is read here', async () => {
		const driver = new GridFSBucket(t.db, { bucketName: 'uploads' });
		const payload = new Uint8Array(5000).map((_, i) => i % 251);
		const upload = driver.openUploadStream('from-the-driver', {
			metadata: { note: 'written by the driver' },
		});
		await new Promise<void>((resolve, reject) => {
			upload.on('finish', () => resolve());
			upload.on('error', reject);
			upload.end(payload);
		});
		const file = await anything().get(upload.id as ObjectId);
		expect(file.filename).toBe('from-the-driver');
		expect(file.size).toBe(5000);
		expect(file.metadata as unknown).toEqual({
			note: 'written by the driver',
		});
		expect(await file.bytes()).toEqual(payload);
		// It carries no digest, so it has no `ETag` — and `serve` still works.
		expect(file.sha256).toBeUndefined();
	});
});
