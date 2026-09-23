import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { Collection, Db } from 'mongodb';
import { Binary, GridFSBucket, ObjectId } from 'mongodb';
import { avatars, clips, uploads } from '../../test/buckets';
import { rejection, rejectionMessage } from '../../test/rejection';
import { startMongo, type TestServer } from '../../test/server';
import {
	ConflictError,
	CorruptFileError,
	InvalidCursorError,
	NotFoundError,
} from '../errors/data-error';
import { withTransaction } from '../transaction/with-transaction';
import { defineBucket } from './define-bucket';
import { getFiles, type PutOnceOptions } from './get-files';
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

/** What a `files` document's `_id` may be: GridFS does not say `ObjectId`. */
type FilesId = ObjectId | string | number;

/**
 * The same database, with the first `files` insert made against it held open.
 *
 * Nothing else is changed: the delay is the latency a loaded machine hands
 * out for free, made to happen on purpose so that a test can depend on it.
 * It lands between a call's last chunk and its document, which is the one
 * window where a second caller can see neither.
 */
function held(db: Db, ms: number): Db {
	let first = true;
	return new Proxy(db, {
		get(target, key, receiver) {
			if (key !== 'collection') return Reflect.get(target, key, receiver);
			return (name: string, ...rest: unknown[]) => {
				const real = (
					target.collection as (n: string, ...r: unknown[]) => Collection
				)(name, ...rest);
				if (!name.endsWith('.files')) return real;
				return new Proxy(real, {
					get(collection, member, from) {
						if (member !== 'insertOne') {
							return Reflect.get(collection, member, from);
						}
						return async (...args: unknown[]) => {
							if (first) {
								first = false;
								await Bun.sleep(ms);
							}
							return (collection.insertOne as (...a: unknown[]) => unknown)(
								...args,
							);
						};
					},
				});
			};
		},
	});
}
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
		// The call, the bucket and the shape — never the value.
		for (const [source, shape] of [
			[42, 'a number'],
			[null, 'null'],
			[{ secret: 'x' }, 'an object'],
			[new Map(), 'a Map'],
			// An own `constructor` is data from the caller, never a class name.
			[JSON.parse('{"constructor":{"name":"sk_live_SECRET"}}'), 'an object'],
			[{ constructor: Map }, 'an object'],
			// Nor is a prototype's `constructor` that is not a function.
			[Object.create({ constructor: { name: 'sk_live_SECRET' } }), 'an object'],
			[
				Object.defineProperty({}, 'constructor', {
					get() {
						throw new Error('the getter ran');
					},
				}),
				'an object',
			],
			[
				Object.create(
					Object.defineProperty({}, 'constructor', {
						get() {
							throw new Error('the prototype getter ran');
						},
					}),
				),
				'an object',
			],
		] as const) {
			const failed = await files.put(source as never).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(failed).toBeInstanceOf(TypeError);
			expect((failed as Error).message).toBe(
				'put on "uploads": expected a file, a blob, a response, a stream ' +
					`or bytes, not ${shape}`,
			);
		}
		const empty = await files.put(new Response(null)).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect((empty as Error).message).toBe(
			'put on "uploads": this Response has no body, so it has nothing to store.',
		);
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
		expect(
			await rejection(files.put(bytes(8), { metadata: {} as never })),
		).toBeInstanceOf(Error);
		expect(
			await rejection(
				files.put(bytes(8), {
					metadata: { userId: new ObjectId(), width: 0 } as never,
				}),
			),
		).toBeInstanceOf(Error);
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
		expect(
			await rejectionMessage(
				anything().put(bytes(8), { metadata: { contentType: 'text/plain' } }),
			),
		).toMatch(/kept by "uploads" itself/);
		// `validate: 'off'` is about the schema, and these two are not the
		// schema's: the refusal comes before anything is parsed.
		expect(
			await rejectionMessage(
				getFiles(t.db, uploads, { validate: 'off' }).put(bytes(8), {
					metadata: { sha256: 'deadbeef' },
				}),
			),
		).toMatch(/kept by "uploads" itself/);
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
		expect(await rejection(files.get(missing))).toBeInstanceOf(NotFoundError);
	});

	test('refuses an id that is not one', async () => {
		expect(await rejection(anything().get('not-an-id'))).toBeInstanceOf(Error);
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
		expect(await rejectionMessage(files.putOnce(bytes(8)))).toMatch(
			/nothing to compare/,
		);
	});

	test('stores it under the id its bytes decide', async () => {
		const files = anything();
		const { file } = await files.putOnce(bytes(2048));
		const digest = createHash('sha256').update(bytes(2048)).digest('hex');
		// Not a resemblance: the id is the first twelve bytes of the digest,
		// which is what lets the server elect between two callers.
		expect(String(file._id)).toBe(digest.slice(0, 24));
		expect(file.sha256).toBe(digest);
	});

	test('refuses an id, because the bytes are what decides it', async () => {
		const files = anything();
		// The types refuse this — `test/types/gridfs.ts` holds that case. This
		// is the other half: an options bag that never met them.
		const given = { id: new ObjectId() } as PutOnceOptions<typeof uploads>;
		expect(await rejectionMessage(files.putOnce(bytes(8), given))).toMatch(
			/the bytes decide the id/,
		);
		expect((await files.paginate()).items).toHaveLength(0);
	});

	test('refuses to answer with a file whose bytes are not these', async () => {
		const files = anything();
		const mine = bytes(64, 1);
		const digest = createHash('sha256').update(mine).digest('hex');
		// Two digests that share their first twelve bytes are what no one has
		// ever produced. This is what it would look like if someone did: some
		// other file, stored under the id these bytes decide. `put` takes an
		// id, so the collision can be built rather than waited for.
		await files.put(bytes(64, 2), { id: digest.slice(0, 24) });
		expect(await rejectionMessage(files.putOnce(mine))).toMatch(
			/already has a different file under _id/,
		);
		// And the file that was there is untouched: a call that cannot store
		// its bytes does not take someone else's with it.
		expect(await (await files.get(digest.slice(0, 24))).bytes()).toEqual(
			bytes(64, 2),
		);
		expect((await files.paginate()).items).toHaveLength(1);
		expect(await t.db.collection('uploads.chunks').countDocuments()).toBe(1);
	});

	test('a sweep of chunks with no file leaves the files alone', async () => {
		// The recipe the README gives for leftover chunks, run over the state
		// that catches a careless one out: an id that a stored file holds,
		// which is exactly what the digest-mismatch error is raised about.
		// Deleting there destroys bytes somebody can still read.
		const files = anything();
		const mine = bytes(64, 1);
		const digest = createHash('sha256').update(mine).digest('hex');
		const theirs = await files.put(bytes(64, 2), { id: digest.slice(0, 24) });
		await files.put(bytes(700));
		const orphan = new ObjectId();
		await t.db
			.collection('uploads.chunks')
			.insertOne({ files_id: orphan, n: 0, data: mine });

		// And a file some other client wrote under an id of its own: GridFS
		// allows any `_id`, and a guard built for a route — where an id that
		// is not 24 hex must read as "not found" — answers `false` for it.
		// Written as documents rather than through `GridFSBucket`, whose own
		// types are narrower than GridFS is: `openUploadStreamWithId` asks
		// for an `ObjectId` the format does not require.
		await t.db
			.collection<{
				_id: FilesId;
				length: number;
				chunkSize: number;
				uploadDate: Date;
				filename: string;
			}>('uploads.files')
			.insertOne({
				_id: 'kept-by-hand',
				length: 64,
				chunkSize: 255 * 1024,
				uploadDate: new Date(),
				filename: 'x.bin',
			});
		await t.db
			.collection<{ files_id: FilesId; n: number; data: Uint8Array }>(
				'uploads.chunks',
			)
			.insertOne({ files_id: 'kept-by-hand', n: 0, data: bytes(64, 3) });

		const collections = files.definition.collections;
		const stored = t.db.collection<{ _id: FilesId }>(collections.files);
		const chunks = t.db.collection<{ files_id: FilesId }>(collections.chunks);
		for await (const { _id } of chunks.aggregate<{ _id: FilesId }>([
			{ $group: { _id: '$files_id' } },
		])) {
			if (await stored.findOne({ _id }, { projection: { _id: 1 } })) continue;
			await chunks.deleteMany({ files_id: _id });
		}

		expect(await chunks.countDocuments({ files_id: orphan })).toBe(0);
		expect(await (await files.get(theirs._id)).bytes()).toEqual(bytes(64, 2));
		expect(await chunks.countDocuments({ files_id: 'kept-by-hand' })).toBe(1);
		expect((await files.paginate()).items).toHaveLength(3);
	});

	test('gives back a copy `put` wrote, rather than storing a second', async () => {
		const files = anything();
		// `put` chooses no id from the bytes, so this copy is nowhere near
		// where `putOnce` would store one. It is still the same bytes.
		const there = await files.put(bytes(700));
		const again = await files.putOnce(bytes(700));
		expect(again.stored).toBe(false);
		expect(again.file._id).toEqual(there._id);
		expect((await files.paginate()).items).toHaveLength(1);
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

	test('refuses a cursor written for the other order, by name', async () => {
		const files = anything();
		await files.put(bytes(8));
		await files.put(bytes(9));
		const page = await files.paginate({ limit: 1 });
		const error = await files
			.paginate({ limit: 1, order: 'oldest', after: page.nextCursor })
			.then(
				() => undefined,
				(reason: unknown) => reason,
			);
		// The whole sentence, because the call it names is deliberate:
		// `paginate` is the method a consumer wrote, not `paginateFiles`,
		// which is the function behind it. A `/ordering/` match passed before
		// the name existed and would pass if it were lost again.
		expect(error).toBeInstanceOf(InvalidCursorError);
		expect(error).toHaveProperty('code', 'INVALID_CURSOR');
		expect(error).toHaveProperty('collection', 'uploads.files');
		expect((error as Error).message).toBe(
			'Invalid cursor in paginate on "uploads": it was written for the ' +
				'ordering uploadDate:desc, not uploadDate:asc',
		);
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
		expect(await rejection(files.delete(missing))).toBeInstanceOf(
			NotFoundError,
		);
		expect(await rejection(files.rename(missing, 'a'))).toBeInstanceOf(
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
		expect(
			await rejectionMessage(
				withTransaction(t.client, async (session) => {
					await files.withSession(session).put(bytes(2048));
					throw new Error('rolled back');
				}),
			),
		).toContain('rolled back');
		expect((await files.paginate()).items).toEqual([]);
		expect(await t.db.collection('uploads.chunks').countDocuments()).toBe(0);
	});

	test('takes a delete back with it, chunks included', async () => {
		const files = anything();
		const file = await files.put(bytes(2048));
		expect(
			await rejectionMessage(
				withTransaction(t.client, async (session) => {
					await files.withSession(session).delete(file.id);
					throw new Error('rolled back');
				}),
			),
		).toContain('rolled back');
		// `GridFSBucket.delete` takes no session in mongodb 7.6, so this
		// package does the two deletes itself — which is what makes them
		// part of the transaction.
		expect(await files.exists(file.id)).toBe(true);
		expect(await (await files.get(file.id)).bytes()).toEqual(bytes(2048));
	});
});

describe('a stream that was already read', () => {
	/** A web stream of `n` bytes, as a request body would be. */
	const streamOf = (n: number) =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes(n));
				controller.close();
			},
		});
	/** Holds the rejection where it is made; a resolved call is the failure. */
	const refusal = (promise: Promise<unknown>) =>
		promise.then(
			() => {
				throw new Error('the call was expected to be refused');
			},
			(error: unknown) => error,
		);
	const spent = (call: string) =>
		new RegExp(`^${call} on "uploads": this stream was already read`);
	const count = (name: string) => t.db.collection(name).countDocuments();

	test('a transaction the driver runs twice is refused, not stored empty', async () => {
		// Measured on mongod 8.2.6: `autoSync` creates `uploads.chunks` outside
		// the session, after the snapshot the insert below opened, so the
		// commit fails with 112 and the driver runs the body again — over the
		// stream its first run spent. Before the refusal, that second run
		// stored a file of 0 bytes and committed the row beside it.
		const files = getFiles(t.db, uploads, { autoSync: true });
		const stream = streamOf(10);
		let attempts = 0;
		const failed = await refusal(
			withTransaction(t.client, async (session) => {
				attempts += 1;
				await t.db.collection('rows').insertOne({ attempts }, { session });
				await files.withSession(session).put(stream);
			}),
		);
		expect(attempts).toBe(2);
		expect(failed).toBeInstanceOf(TypeError);
		expect((failed as Error).message).toMatch(spent('put'));
		expect(await count('uploads.files')).toBe(0);
		expect(await count('uploads.chunks')).toBe(0);
		expect(await count('rows')).toBe(0);
	});

	test('a second put of the same stream is refused, and writes nothing', async () => {
		const files = anything();
		const stream = streamOf(10);
		expect((await files.put(stream)).size).toBe(10);
		const again = await refusal(files.put(stream));
		expect(again).toBeInstanceOf(TypeError);
		expect((again as Error).message).toMatch(spent('put'));
		const once = await refusal(files.putOnce(stream));
		expect((once as Error).message).toMatch(spent('putOnce'));
		expect(await count('uploads.files')).toBe(1);
		expect(await count('uploads.chunks')).toBe(1);
	});

	test('refuses one the caller drained, read partly, or holds locked', async () => {
		const files = anything();
		const drained = streamOf(10);
		await new Response(drained).arrayBuffer();
		const partly = streamOf(10);
		const reader = partly.getReader();
		await reader.read();
		reader.releaseLock();
		const locked = streamOf(10);
		locked.getReader();
		// A response whose body somebody holds a reader on: not used yet, so
		// `bodyUsed` is false, and still nothing this call can read.
		const body = streamOf(4);
		const response = new Response(body);
		body.getReader();
		for (const source of [drained, partly, locked, response]) {
			const failed = await refusal(files.put(source));
			expect((failed as Error).message).toMatch(spent('put'));
		}
		expect(await count('uploads.files')).toBe(0);
	});

	test('refuses a generator or a node stream the first put read', async () => {
		const files = anything();
		async function* generated() {
			yield bytes(3);
			yield bytes(4);
		}
		const generator = generated();
		const node = Readable.from([Buffer.from(bytes(5))]);
		expect((await files.put(generator)).size).toBe(7);
		expect((await files.put(node)).size).toBe(5);
		for (const source of [generator, node]) {
			const failed = await refusal(files.put(source));
			expect((failed as Error).message).toMatch(spent('put'));
		}
		expect(await count('uploads.files')).toBe(2);
	});

	test('refuses a Response the first put read, through putOnce too', async () => {
		const files = anything();
		const response = new Response('hello');
		expect((await files.put(response)).size).toBe(5);
		const again = await refusal(files.put(response));
		expect((again as Error).message).toMatch(spent('put'));
		const once = await refusal(files.putOnce(response));
		expect((once as Error).message).toMatch(spent('putOnce'));
		expect(await count('uploads.files')).toBe(1);
	});

	test('refuses a node stream the caller read one byte of, ended or destroyed', async () => {
		// Each flag on its own: `read(1)` sets `readableDidRead` alone,
		// `destroy()` on a stream nobody read sets `destroyed` alone — which
		// without the refusal fails with `Premature close`, not this — and a
		// stream that ended while flowing with nothing read sets
		// `readableEnded` alone, and would be read as no bytes.
		const make = () => {
			const node = new Readable({ read() {} });
			node.push(Buffer.from('abcdef'));
			node.push(null);
			return node;
		};
		const partly = make();
		partly.read(1);
		const destroyed = make();
		destroyed.destroy();
		const ended = new Readable({ read() {}, autoDestroy: false });
		ended.push(null);
		ended.resume();
		await new Promise((resolve) => ended.once('end', resolve));
		expect([
			ended.readableDidRead,
			ended.readableEnded,
			ended.destroyed,
		]).toEqual([false, true, false]);
		for (const source of [partly, destroyed, ended]) {
			const failed = await refusal(anything().put(source));
			expect((failed as Error).message).toMatch(spent('put'));
		}
		expect(await count('uploads.files')).toBe(0);
	});

	test('a generator a put refused before reading is stored whole by the next', async () => {
		// Marked on its first pull, not when it is handed over: a conflict on
		// the id reads nothing, so the generator still has every byte.
		const files = anything();
		async function* generated() {
			yield bytes(3);
			yield bytes(4);
		}
		const generator = generated();
		const taken = new ObjectId();
		await files.put(bytes(1), { id: taken });
		const conflict = await refusal(files.put(generator, { id: taken }));
		expect(conflict).toBeInstanceOf(ConflictError);
		const stored = await files.put(generator);
		expect(await stored.bytes()).toEqual(
			new Uint8Array([...bytes(3), ...bytes(4)]),
		);
	});

	test('an iterable with a `next` of its own is read afresh, not refused', async () => {
		// Only an iterator that is its own `Symbol.asyncIterator` is spent by
		// being read; this one hands out a new generator every time.
		const afresh = {
			next: () => Promise.resolve({ done: true as const, value: undefined }),
			async *[Symbol.asyncIterator]() {
				yield bytes(6);
			},
		};
		const files = anything();
		expect((await files.put(afresh)).size).toBe(6);
		expect((await files.put(afresh)).size).toBe(6);
	});

	test('still takes an empty stream nobody read, and a source that reads afresh', async () => {
		const files = anything();
		const empty = new ReadableStream<Uint8Array>({ start: (c) => c.close() });
		expect((await files.put(empty)).size).toBe(0);
		// An iterable that hands out a new iterator each time is not spent by
		// being read: it is not refused, and it stores its bytes every time.
		const afresh = {
			async *[Symbol.asyncIterator]() {
				yield bytes(6);
			},
		};
		expect((await files.put(afresh)).size).toBe(6);
		expect((await files.put(afresh)).size).toBe(6);
		// A put refused before reading leaves the stream for the next one.
		const stream = streamOf(10);
		const taken = new ObjectId();
		await files.put(bytes(1), { id: taken });
		const conflict = await refusal(files.put(stream, { id: taken }));
		expect(conflict).toBeInstanceOf(ConflictError);
		expect((await files.put(stream)).size).toBe(10);
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
		expect(await rejectionMessage(files.put(failing))).toMatch(/gave up/);
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
		expect(await rejection(found.bytes())).toBeInstanceOf(CorruptFileError);
		expect(await rejectionMessage(found.bytes())).toMatch(
			/Chunk 2 .* is missing/,
		);
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
		expect(await rejection((await files.get(file.id)).bytes())).toBeInstanceOf(
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
		expect(
			await rejection(files.put(bytes(70, 2), { id, chunkSize: 7 })),
		).toBeInstanceOf(ConflictError);
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
		// A `Uint8Array` is read once, so both calls upload, and neither
		// check can see a file whose `files` document is not in yet. What
		// settles it is that the bytes decide the id, so the two copies
		// collide on the server rather than on a rule each call works out
		// for itself.
		const [one, other] = await Promise.all([
			files.putOnce(bytes(4096)),
			files.putOnce(bytes(4096)),
		]);
		expect(one.file.id).toBe(other.file.id);
		expect([one.stored, other.stored].filter(Boolean)).toHaveLength(1);
		expect((await files.paginate()).items).toHaveLength(1);
		expect(await (await files.get(one.file.id)).bytes()).toEqual(bytes(4096));
	});

	test('a `Blob` collides too, rather than storing twice', async () => {
		const files = anything();
		// The check-then-write path cannot see a file whose `files` document
		// has not been written yet, so it ends in the same collision.
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

	test('waits for the winner, and says so when it never comes', async () => {
		const files = anything();
		const mine = bytes(1024, 3);
		const digest = createHash('sha256').update(mine).digest('hex');
		// What a write that claimed the id and then died leaves behind: the
		// first chunk under it, and no file. A caller cannot tell that from a
		// winner that is one round trip away, so it waits, and then says which
		// of the two it is looking at.
		await files.putOnce(bytes(16));
		await t.db.collection('uploads.chunks').insertOne({
			files_id: new ObjectId(digest.slice(0, 24)),
			n: 0,
			data: mine,
		});
		const began = Date.now();
		expect(await rejectionMessage(files.putOnce(mine))).toMatch(
			/another write holds _id .* and has not finished/,
		);
		// Bounded, and long enough that a winner on a loaded machine is not
		// declared dead: ten seconds.
		expect(Date.now() - began).toBeGreaterThan(9_000);
		expect((await files.paginate()).items).toHaveLength(1);
	}, 30_000);

	test('refuses rather than store a file a stray chunk cuts short', async () => {
		const files = anything();
		const mine = bytes(3000, 5);
		const digest = createHash('sha256').update(mine).digest('hex');
		await files.putOnce(bytes(16));
		// Chunk 0 free and a later one taken: what a write killed between its
		// two moves leaves behind. Claiming 0 and then quietly failing to
		// move the rest would store a file that reads short for ever — the
		// same lie this call exists to stop telling.
		await t.db.collection('uploads.chunks').insertOne({
			files_id: new ObjectId(digest.slice(0, 24)),
			n: 1,
			data: mine,
		});
		expect(
			await rejectionMessage(files.putOnce(mine, { chunkSize: 1024 })),
		).toMatch(/chunk 0 was free and a later one was not/);
		expect((await files.paginate()).items).toHaveLength(1);
		// Its own chunks are back out, the stray one is untouched.
		expect(
			await t.db
				.collection('uploads.chunks')
				.countDocuments({ files_id: new ObjectId(digest.slice(0, 24)) }),
		).toBe(1);
	});

	test('takes over an id whose claim was let go, rather than waiting it out', async () => {
		const files = anything();
		const mine = bytes(1024, 6);
		const digest = createHash('sha256').update(mine).digest('hex');
		const _id = new ObjectId(digest.slice(0, 24));
		await files.putOnce(bytes(16));
		await t.db
			.collection('uploads.chunks')
			.insertOne({ files_id: _id, n: 0, data: mine });
		// The write that held the id gives up without ever writing its
		// document. Nobody is coming, and this call is holding every byte the
		// id needs, so waiting the full ten seconds would be waiting for
		// nothing.
		const began = Date.now();
		const taking = files.putOnce(mine);
		setTimeout(() => {
			void t.db.collection('uploads.chunks').deleteOne({ files_id: _id, n: 0 });
		}, 200);
		const { file, stored } = await taking;
		expect(stored).toBe(true);
		expect(String(file._id)).toBe(digest.slice(0, 24));
		expect(Date.now() - began).toBeLessThan(5_000);
		expect(await (await files.get(_id)).bytes()).toEqual(mine);
	}, 30_000);

	test('asks again before taking over: the wait is long enough to be wrong', async () => {
		const files = anything();
		const mine = bytes(1024, 7);
		const digest = createHash('sha256').update(mine).digest('hex');
		const _id = new ObjectId(digest.slice(0, 24));
		await files.putOnce(bytes(16));
		await t.db
			.collection('uploads.chunks')
			.insertOne({ files_id: _id, n: 0, data: mine });
		// The check that found nothing is as old as the wait is long, and a
		// plain `put` takes no part in the election. Taking the id over on
		// that stale answer stores the same bytes a second time.
		const taking = files.putOnce(mine);
		const put = await files.put(mine);
		await t.db.collection('uploads.chunks').deleteOne({ files_id: _id, n: 0 });
		const { file, stored } = await taking;
		expect(stored).toBe(false);
		expect(file._id).toEqual(put._id);
		expect(
			await t.db
				.collection('uploads.files')
				.countDocuments({ 'metadata.sha256': digest }),
		).toBe(1);
	}, 30_000);

	test('inside a transaction, a collision is the transaction’s to lose', async () => {
		const files = anything();
		const mine = bytes(1024, 4);
		const digest = createHash('sha256').update(mine).digest('hex');
		await files.putOnce(bytes(16));
		await t.db.collection('uploads.chunks').insertOne({
			files_id: new ObjectId(digest.slice(0, 24)),
			n: 0,
			data: mine,
		});
		// Measured: the duplicate key aborts the transaction on the server, so
		// what comes back is the abort and not this package's `ConflictError`.
		// There is nothing to wait for either — a document another transaction
		// wrote is not in this one's snapshot however long it waits.
		expect(
			await rejectionMessage(
				withTransaction(t.client, async (session) => {
					await files.withSession(session).putOnce(mine);
				}),
			),
		).toMatch(/aborted/);
	}, 30_000);

	test('one of them finishing last changes nothing', async () => {
		// Left to chance, three calls on one machine interleave the same way
		// almost every time, and the order they happen to run in is exactly
		// what this has to not depend on. So one call is held open between
		// its last chunk and its document, long enough for the other two to
		// arrive and find neither: it is last to the server while it was
		// first to start, and it carries the earliest `uploadDate` of the
		// three.
		//
		// This is the interleaving that a contended CI machine handed out on
		// its own, and it used to leave two files and two different ids —
		// each caller had found itself first in `(uploadDate, _id)`, a key
		// that says nothing about the order the documents become visible.
		const files = getFiles(held(t.db, 200), uploads);
		const all = await Promise.all([
			files.putOnce(bytes(3000)),
			files.putOnce(bytes(3000)),
			files.putOnce(bytes(3000)),
		]);
		expect(new Set(all.map((r) => r.file.id)).size).toBe(1);
		expect(all.filter((r) => r.stored)).toHaveLength(1);
		expect((await files.paginate()).items).toHaveLength(1);
		const [kept] = all;
		if (!kept) throw new Error('unreachable');
		expect(await (await files.get(kept.file.id)).bytes()).toEqual(bytes(3000));
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
		expect(await rejection(found.bytes())).toBeInstanceOf(CorruptFileError);
		expect(await rejectionMessage(found.bytes())).toMatch(
			/reads 66 bytes where/,
		);
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
		expect(await rejection((await files.get(file.id)).bytes())).toBeInstanceOf(
			CorruptFileError,
		);
	});
});

describe('a chunk whose `data` is not bytes', () => {
	test('names the chunk, the file and the bucket', async () => {
		const files = anything();
		const file = await files.put(bytes(70), { chunkSize: 7 });
		// A chunk written by something that is not GridFS. The read used to
		// answer `A chunk of this file holds no bytes`, which named neither
		// the bucket, nor the file, nor which chunk — while its two
		// neighbours, a missing chunk and a short one, named all three.
		await t.db
			.collection('uploads.chunks')
			.updateOne({ files_id: file._id, n: 4 }, { $set: { data: 'nope' } });
		const found = await files.get(file.id);
		const error = await found.bytes().then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(error).toBeInstanceOf(CorruptFileError);
		expect(error).toHaveProperty('code', 'CORRUPT_FILE');
		expect(error).toHaveProperty('collection', 'uploads.chunks');
		expect((error as Error).message).toBe(
			`Chunk 4 of file ${String(file._id)} in "uploads" holds a string ` +
				'where its bytes should be: the chunk was written by something ' +
				'that is not GridFS, or its `data` was overwritten',
		);
	});

	test('a chunk with no `data` field at all says so', async () => {
		const files = anything();
		const file = await files.put(bytes(70), { chunkSize: 7 });
		await t.db
			.collection('uploads.chunks')
			.updateOne({ files_id: file._id, n: 0 }, { $unset: { data: '' } });
		expect(await rejectionMessage((await files.get(file.id)).bytes())).toMatch(
			/Chunk 0 of file .* in "uploads" holds no data field/,
		);
	});

	test('it says `an array` and `null`, not `a array` and `a null`', async () => {
		const files = anything();
		const file = await files.put(bytes(70), { chunkSize: 7 });
		const chunks = t.db.collection('uploads.chunks');
		await chunks.updateOne(
			{ files_id: file._id, n: 1 },
			{ $set: { data: [] } },
		);
		expect(await rejectionMessage((await files.get(file.id)).bytes())).toMatch(
			/holds an array where its bytes should be/,
		);
		await chunks.updateOne(
			{ files_id: file._id, n: 1 },
			{ $set: { data: null } },
		);
		expect(await rejectionMessage((await files.get(file.id)).bytes())).toMatch(
			/holds null where its bytes should be/,
		);
	});
});

describe('a `limit` a listing will not take', () => {
	test('the refusal names the call and the bucket', async () => {
		const files = anything();
		// A collection's `paginate` and a bucket's both refuse a `limit` of 0,
		// and both used to say only `limit must be an integer of at least 1` —
		// one sentence, two calls, written twice. The name tells them apart.
		const error = await files.paginate({ limit: 0 }).then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(error).toBeInstanceOf(RangeError);
		expect((error as Error).message).toBe(
			'paginate on "uploads": limit must be an integer of at least 1, not 0',
		);
	});
});

describe('a bucket with no chunk index', () => {
	// Two buckets of their own, read nowhere else in this file. The hint is
	// given once per database and bucket for the life of the process, so a
	// shared bucket would make these tests depend on what ran before them —
	// and make the rest of the file hear a warning it is not about.
	const unindexed = defineBucket({ name: 'warned' });
	const indexed = defineBucket({ name: 'warned-synced' });

	/** The warnings a body emits, as this process would print them. */
	async function warnings(body: () => Promise<unknown>): Promise<string[]> {
		const heard: string[] = [];
		const listen = (warning: Error) => {
			if ((warning as { code?: string }).code === 'NxgtGridFSMissingIndex') {
				heard.push(warning.message);
			}
		};
		process.on('warning', listen);
		try {
			await body();
			// The probe runs beside the read, not in front of it: it has to be
			// given the turn it needs before the warning can be there.
			for (let i = 0; i < 50 && heard.length === 0; i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		} finally {
			process.off('warning', listen);
		}
		return heard;
	}

	test('a read says so once, and names the bucket and the collection', async () => {
		const files = getFiles(t.db, unindexed);
		const file = await files.put(bytes(70), { chunkSize: 7 });
		// `put` creates nothing; only `putOnce` and `autoSync` do. So this is
		// the state an application is in until it calls `syncIndexes()`: reads
		// that work, and scan the whole collection to do it.
		expect(
			(await t.db.collection('warned.chunks').indexes()).map((i) => i.name),
		).not.toContain('files_id_1_n_1');

		const heard = await warnings(async () => {
			expect(await (await files.get(file.id)).bytes()).toEqual(bytes(70));
		});
		expect(heard).toEqual([
			'Bucket "warned" has no files_id_1_n_1 on "warned.chunks": every ' +
				'read scans the whole collection, and the cost grows with the ' +
				'bucket rather than with the file. Call syncIndexes() at ' +
				'start-up, or bind with autoSync.',
		]);

		// Once per bucket for the life of the process: a second read is silent,
		// and costs no listing of its own.
		const again = await warnings(async () => {
			await (await files.get(file.id)).bytes();
		});
		expect(again).toEqual([]);
	});

	test('a bucket that has the index says nothing', async () => {
		const files = getFiles(t.db, indexed, { autoSync: true });
		const file = await files.put(bytes(70), { chunkSize: 7 });
		const heard = await warnings(async () => {
			await (await files.get(file.id)).bytes();
		});
		expect(heard).toEqual([]);
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

	test('a `drop()` makes `putOnce` create them again', async () => {
		const files = anything();
		await files.putOnce(bytes(16));
		await files.drop();
		// The memo of what this process has created outlives the collections
		// it created them in. Left alone, the next `putOnce` would elect on
		// an index that is no longer there.
		await files.putOnce(bytes(16));
		const chunks = (await t.db.collection('uploads.chunks').indexes()).map(
			(index) => index.name,
		);
		expect(chunks).toContain('files_id_1_n_1');
	});

	test('`putOnce` creates them whatever `autoSync` says', async () => {
		// Not a convenience. The unique `{ files_id, n }` index is what one of
		// two callers collides with, so without it `putOnce` has half an
		// election and both callers' chunks land under the same file.
		await anything().putOnce(bytes(16));
		const chunks = (await t.db.collection('uploads.chunks').indexes()).map(
			(index) => index.name,
		);
		expect(chunks).toContain('files_id_1_n_1');
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
		expect(
			await rejectionMessage(
				getFiles(t.db, defineBucket({ name: 'viewed' })).syncIndexes(),
			),
		).toMatch(/is a view, not a collection/);
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
		expect(
			await rejection(
				withTransaction(t.client, async (session) => {
					await files.withSession(session).drop();
				}),
			),
		).toBeInstanceOf(Error);
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
		expect(await rejection(files.get('not-an-id'))).toBeInstanceOf(
			NotFoundError,
		);
		expect(await rejection(files.delete('not-an-id'))).toBeInstanceOf(
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
