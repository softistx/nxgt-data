import { describe, expect, test } from 'bun:test';
import { defineBucket } from '@nxgt/mongo/gridfs';
import { ObjectId } from 'mongodb';
import {
	avatars,
	buckets,
	collections,
	events,
	useMongo,
} from '../../test/fixtures';
import { defineConfig } from '../config/define-config';
import { KitError } from '../errors/kit-error';
import { createKit } from './create-kit';

const { server, track } = useMongo('kit-buckets');

const bucketKit = async (more: { autoSync?: boolean } = {}) =>
	track(
		await createKit(
			defineConfig({ uri: server.uri, collections, buckets, ...more }),
		),
	);

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

/** What a collection holds, counted from outside the kit. */
const count = (name: string) => server.db.collection(name).countDocuments();

/** The indexes of a collection, by name; none when it is not there. */
const indexNames = async (name: string) =>
	(
		await server.db
			.collection(name)
			.indexes()
			.catch(() => [])
	).map((index) => index.name);

/**
 * The rejection of a promise, held where the promise is made: see AGENTS.md,
 * "A spec that watches a promise reject".
 */
const rejection = (promise: Promise<unknown>): Promise<unknown> =>
	promise.then(
		() => {
			throw new Error('it resolved, and should have rejected');
		},
		(reason: unknown) => reason,
	);

describe('a bucket on the scope', () => {
	test('puts and gets a file, its metadata typed and coerced', async () => {
		const kit = await bucketKit();
		const userId = new ObjectId();
		const put = await kit.db.avatars.put(bytes(3000), {
			filename: 'ada.png',
			metadata: { userId: userId.toHexString(), width: 64 },
		});
		const file = await kit.db.avatars.get(put.id);
		expect(await file.bytes()).toEqual(bytes(3000));
		expect(file.filename).toBe('ada.png');
		expect(file.metadata.userId).toBeInstanceOf(ObjectId);
		expect(file.metadata.userId.equals(userId)).toBe(true);
		expect(await count('avatars.files')).toBe(1);
	});

	test('lists the buckets beside the collections, and nothing else', async () => {
		const kit = await bucketKit();
		expect(Object.keys(kit.db)).toEqual([
			'users',
			'posts',
			'avatars',
			'uploads',
		]);
		expect('MAX_SIZE' in kit.db).toBe(false);
		expect(kit.db.avatars.definition).toBe(avatars);
	});

	test('gives the same bucket back at every read', async () => {
		const kit = await bucketKit();
		expect(kit.db.avatars).toBe(kit.db.avatars);
		expect(kit.db.uploads).not.toBe(kit.db.avatars as never);
	});

	test('passes bucketOptions to every bucket', async () => {
		const kit = track(
			await createKit(
				defineConfig({
					uri: server.uri,
					collections,
					buckets,
					bucketOptions: { hash: false },
				}),
			),
		);
		const file = await kit.db.uploads.put(bytes(10));
		expect(file.sha256).toBeUndefined();
		// Without the option, the bucket hashes: the option is what changed it.
		const plain = await bucketKit();
		expect((await plain.db.uploads.put(bytes(10))).sha256).toBeString();
	});

	test('creates the indexes before the first call when autoSync is on', async () => {
		const kit = await bucketKit({ autoSync: true });
		await kit.db.avatars.put(bytes(10), {
			metadata: { userId: new ObjectId() },
		});
		expect(await indexNames('avatars.chunks')).toContain('files_id_1_n_1');
	});

	test('creates none when autoSync is off', async () => {
		const kit = await bucketKit();
		await kit.db.uploads.put(bytes(10));
		expect(await indexNames('uploads.chunks')).not.toContain('files_id_1_n_1');
	});
});

describe('a bucket in a session', () => {
	test('a derived kit carries its session to the bucket', async () => {
		const kit = await bucketKit();
		const session = server.client.startSession();
		try {
			const derived = kit.withSession(session);
			expect(derived.db.avatars.session).toBe(session);
			expect(kit.db.avatars.session).toBeUndefined();
			expect(derived.db.avatars).not.toBe(kit.db.avatars);
			// And the actor a kit stamps does not reach a bucket, which has none.
			expect(kit.as(new ObjectId()).db.avatars.session).toBeUndefined();
		} finally {
			await session.endSession();
		}
	});

	test('a transaction gives its buckets its session', async () => {
		const kit = await bucketKit();
		const seen = await kit.transaction(async (tx) => ({
			bucket: tx.db.uploads.session,
			kit: tx.session,
		}));
		expect(seen.bucket).toBeDefined();
		expect(seen.bucket).toBe(seen.kit);
	});

	test('a transaction that throws leaves no file', async () => {
		const kit = await bucketKit();
		const failed = await rejection(
			kit.transaction(async (tx) => {
				await tx.db.users.create({ email: 'ada@example.com' });
				await tx.db.uploads.put(bytes(600_000));
				throw new Error('rolled back');
			}),
		);
		expect(failed).toHaveProperty('message', 'rolled back');
		expect(await count('uploads.files')).toBe(0);
		expect(await count('uploads.chunks')).toBe(0);
		expect(await count('users')).toBe(0);
	});

	test('a transaction that commits leaves the file beside the document', async () => {
		const kit = await bucketKit();
		const { user, file } = await kit.transaction(async (tx) => {
			const user = await tx.db.users.create({ email: 'ada@example.com' });
			const file = await tx.db.avatars.put(bytes(600_000), {
				metadata: { userId: user._id },
			});
			return { user, file };
		});
		expect(await count('users')).toBe(1);
		const stored = await kit.db.avatars.get(file.id);
		expect(stored.metadata.userId.equals(user._id)).toBe(true);
		expect(await stored.bytes()).toEqual(bytes(600_000));
		// 600 000 bytes are three chunks of 255 KiB: every one committed.
		expect(await count('avatars.chunks')).toBe(3);
	});
});

describe('syncBuckets', () => {
	test('creates the four indexes, and a second run creates none', async () => {
		const kit = await bucketKit();
		const first = await kit.syncBuckets();
		expect(Object.keys(first)).toEqual(['default']);
		expect(Object.keys(first.default)).toEqual(['avatars', 'uploads']);
		const created = first.default.avatars.flatMap((report) => report.created);
		expect(created.sort()).toEqual([
			'filename_1_uploadDate_1',
			'files_id_1_n_1',
			'nxgt_sha256',
			'nxgt_uploadDate_id',
		]);
		expect(await indexNames('uploads.chunks')).toContain('files_id_1_n_1');

		const second = await kit.syncBuckets();
		for (const reports of Object.values(second.default)) {
			expect(reports.flatMap((report) => report.created)).toEqual([]);
			expect(reports.flatMap((report) => report.existing)).toHaveLength(4);
		}
	});

	test('is not what `sync` does', async () => {
		const kit = await bucketKit();
		await kit.sync();
		expect(await indexNames('avatars.chunks')).toEqual([]);
	});

	test('reports every database, one with no bucket as empty', async () => {
		const kit = track(
			await createKit(
				defineConfig({
					databases: {
						main: { uri: server.uri, collections, buckets },
						analytics: {
							uri: server.uri,
							database: 'kit-buckets-analytics',
							collections: { events },
						},
					},
				}),
			),
		);
		const reports = await kit.syncBuckets();
		expect(Object.keys(reports)).toEqual(['main', 'analytics']);
		expect(reports.analytics).toEqual({});
		expect(Object.keys(reports.main)).toEqual(['avatars', 'uploads']);
	});
});

describe('createKit', () => {
	test('refuses a bucket under a key the driver`s Db answers to', async () => {
		const failed = await rejection(
			createKit(
				defineConfig({
					uri: server.uri,
					collections,
					buckets: { watch: defineBucket({ name: 'watch' }) },
				} as never),
			),
		);
		expect(failed).toBeInstanceOf(KitError);
		expect(failed).toHaveProperty('code', 'COLLISION');
		expect(failed).toHaveProperty('key', 'watch');
		expect(failed).toHaveProperty(
			'message',
			expect.stringContaining('wires a bucket under "watch"'),
		);
	});
});
