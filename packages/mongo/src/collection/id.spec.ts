import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { type CommandStartedEvent, MongoClient, ObjectId } from 'mongodb';
import { z } from 'zod';
import { rejection, rejectionMessage } from '../../test/rejection';
import { posts, users } from '../../test/schema';
import { startMongo, type TestServer } from '../../test/server';
import { defineCollection } from '../definition/define-collection';
import { id } from '../definition/fields';
import { getCollection } from './get-collection';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo();
}, 120_000);
beforeEach(() => t.reset());
afterAll(() => t.stop());

async function seed() {
	const collection = getCollection(t.db, users);
	await collection.sync();
	const ada = await collection.create({ email: 'ada@example.com' });
	return { collection, ada };
}

describe('the id of a document', () => {
	test('is _id as a string, on everything a collection gives back', async () => {
		const { collection, ada } = await seed();
		expect(ada.id).toBe(ada._id.toHexString());

		expect((await collection.getById(ada._id)).id).toBe(ada.id);
		expect((await collection.findById(ada._id))?.id).toBe(ada.id);
		expect((await collection.findFirst({ email: 'ada@example.com' }))?.id).toBe(
			ada.id,
		);
		expect((await collection.findMany())[0]?.id).toBe(ada.id);
		expect((await collection.paginate()).items[0]?.id).toBe(ada.id);
		expect((await collection.paginateByCursor()).items[0]?.id).toBe(ada.id);
		expect((await collection.update(ada._id, { name: 'Ada' })).id).toBe(ada.id);
		expect((await collection.delete(ada._id)).id).toBe(ada.id);
		expect((await collection.restore(ada._id)).id).toBe(ada.id);
		expect((await collection.hardDelete(ada._id)).id).toBe(ada.id);
	});

	test('createMany gives one to each', async () => {
		const collection = getCollection(t.db, posts);
		await collection.sync();
		const created = await collection.createMany([
			{ title: 'a', rank: 1 },
			{ title: 'b', rank: 2 },
		]);
		expect(created.map((post) => post.id)).toEqual(
			created.map((post) => post._id.toHexString()),
		);
	});

	test('is carried by JSON and by a spread, so a handler can return it', async () => {
		const { ada } = await seed();
		const asJson = JSON.parse(JSON.stringify(ada)) as Record<string, unknown>;
		expect(asJson.id).toBe(ada.id);
		expect({ ...ada }.id).toBe(ada.id);
		expect(Object.keys(ada)).toContain('id');
	});

	test('is computed, never stored', async () => {
		const { ada } = await seed();
		const stored = await t.db.collection('users').findOne({ _id: ada._id });
		expect(stored).not.toBeNull();
		expect(Object.hasOwn(stored as object, 'id')).toBe(false);
	});

	test('a document that was read can be written back', async () => {
		const { collection, ada } = await seed();
		const read = await collection.getById(ada._id);
		// The stamps are the collection's; the rest is written back. The
		// schema strips `id`, so the copy is inserted without it.
		const {
			_id,
			version,
			deletedAt,
			createdBy,
			updatedBy,
			deletedBy,
			...rest
		} = read;
		const copy = await collection.create({
			...rest,
			email: 'copy@example.com',
		});
		expect(copy._id).not.toEqual(ada._id);
		expect(
			Object.hasOwn(
				(await t.db.collection('users').findOne({ _id: copy._id })) as object,
				'id',
			),
		).toBe(false);
	});

	test('validate: off does not parse, and still writes no id', async () => {
		const { collection, ada } = await seed();
		const read = await collection.getById(ada._id);
		const raw = getCollection(t.db, users, { validate: 'off' });
		// Nothing strips the field here: `toDocument` is what drops it, and
		// without it the collection's validator would refuse the document.
		const {
			_id,
			version,
			deletedAt,
			createdBy,
			updatedBy,
			deletedBy,
			...rest
		} = read;
		const written = await raw.create({
			...rest,
			email: 'copy@example.com',
		});
		const stored = await t.db
			.collection('users')
			.findOne({ email: 'copy@example.com' });
		expect(stored).not.toBeNull();
		expect(Object.hasOwn(stored as object, 'id')).toBe(false);
		expect(written).toBeDefined();
	});

	test('validate: off still fills the stamps the collection keeps', async () => {
		const raw = getCollection(t.db, users, { validate: 'off' });
		await raw.sync();
		const at = new Date('2020-01-02T03:04:05Z');
		const written = await raw.create({
			email: 'ada@example.com',
			name: null,
			teamId: null,
			createdAt: at,
		});
		expect(written.createdAt).toEqual(at);
		expect(written.updatedAt).toBeInstanceOf(Date);
		expect(written.version).toBe(0);
		expect(written.deletedAt).toBeNull();
		expect(written.createdBy).toBeNull();
	});

	test('a projection without _id gets none', async () => {
		const { collection } = await seed();
		const [projected] = await collection.findMany({
			projection: { email: 1, _id: 0 },
		});
		expect(projected).toEqual({ email: 'ada@example.com' } as never);
		expect(Object.hasOwn(projected as object, 'id')).toBe(false);
	});

	test('a schema with an id field of its own keeps it', async () => {
		const things = defineCollection({
			name: 'things',
			schema: z.object({ _id: id(), id: z.string() }),
		});
		const collection = getCollection(t.db, things);
		await collection.sync();

		const thing = await collection.create({ id: 'mine' });
		expect(thing.id).toBe('mine');
		// It is a field like any other: stored, and read back as it was.
		const stored = await t.db.collection('things').findOne({ _id: thing._id });
		expect(stored?.id).toBe('mine');
		expect((await collection.getById(thing._id)).id).toBe('mine');
	});
});

/**
 * A collection's database on a client of its own that records every command
 * it sends, so a refusal can be shown to have sent nothing at all.
 */
async function watched() {
	const client = await MongoClient.connect(t.uri, { monitorCommands: true });
	const sent: string[] = [];
	client.on('commandStarted', (event: CommandStartedEvent) => {
		sent.push(event.commandName);
	});
	return { client, db: client.db(t.db.databaseName), sent };
}

const loose = (values: unknown) => values as never;
const stored = (name: string) => t.db.collection(name).find().toArray();
const immutable = (method: string, name: string) =>
	`${method} on "${name}": "_id" is immutable`;

describe('no update writes _id', () => {
	const other = new ObjectId();
	test.each([
		['a new one', { _id: other, name: 'x' }],
		['the same one', 'same'],
		['as a string', { _id: other.toHexString() }],
		['as undefined', { _id: undefined, name: 'x' }],
		['beside an expected version', { _id: other, name: 'x', version: 0 }],
		['through $set', { $set: { _id: other } }],
		['through $set, as undefined', { $set: { name: 'x', _id: undefined } }],
		['through $setOnInsert', { $setOnInsert: { _id: other } }],
		['through $unset', { $unset: { _id: '' } }],
		['renamed away', { $rename: { _id: 'name' } }],
		['renamed onto', { $rename: { name: '_id' } }],
		['under a path', { $set: { '_id.x': 1 } }],
		['through $currentDate', { $currentDate: { _id: true } }],
		['through $min', { $min: { _id: other } }],
		['beside another operator', { $set: { name: 'x' }, $inc: { '_id.n': 1 } }],
	])('%s: refused, and nothing is sent', async (_label, given) => {
		const { collection, ada } = await seed();
		const before = await stored('users');
		const { client, db, sent } = await watched();
		try {
			const mine = getCollection(db, users);
			const patch = given === 'same' ? { _id: ada._id } : given;
			const refused = await rejection(mine.update(ada._id, loose(patch)));
			expect(refused).toBeInstanceOf(TypeError);
			expect((refused as Error).message).toBe(
				'update on "users": "_id" is immutable, and an update never ' +
					'writes it. Leave it out; a document that needs another _id is a ' +
					'new document',
			);
			expect(
				await rejectionMessage(mine.updateMany({ _id: ada._id }, loose(patch))),
			).toStartWith(immutable('updateMany', 'users'));
			// Through `as` and `withSession` too: they are the same calls.
			expect(
				await rejectionMessage(
					mine.as(loose(null)).update(ada._id, loose(patch)),
				),
			).toStartWith(immutable('update', 'users'));
			expect(
				await rejectionMessage(
					mine.withSession(undefined).update(ada._id, loose(patch)),
				),
			).toStartWith(immutable('update', 'users'));
			expect(sent).toEqual([]);
		} finally {
			await client.close();
		}
		expect(await stored('users')).toEqual(before);
		expect(await collection.count()).toBe(1);
	});

	test('the message carries no value', async () => {
		const { collection, ada } = await seed();
		const message = await rejectionMessage(
			collection.update(ada._id, loose({ _id: 'a-value-from-a-body' })),
		);
		expect(message).not.toContain('a-value-from-a-body');
	});

	test('an update without it still goes through, and is sent', async () => {
		const { ada } = await seed();
		const { client, db, sent } = await watched();
		try {
			const mine = getCollection(db, users);
			const updated = await mine.update(ada._id, { name: 'Ada', version: 0 });
			expect(updated._id).toEqual(ada._id);
			expect(updated.name).toBe('Ada');
			expect(await mine.updateMany({ _id: ada._id }, { name: 'A' })).toBe(1);
			expect(sent).toEqual(['findAndModify', 'update']);
		} finally {
			await client.close();
		}
	});

	test('upsert refuses it in its values, on either half, and sends nothing', async () => {
		const board = getCollection(t.db, posts);
		await board.sync();
		const first = await board.create({ title: 'a', rank: 1 });
		const before = await stored('posts');
		const { client, db, sent } = await watched();
		try {
			const mine = getCollection(db, posts);
			for (const [filter, values] of [
				[{ title: 'a' }, { _id: first._id, rank: 2 }],
				[{ title: 'b' }, { _id: new ObjectId(), rank: 2 }],
				[{ title: 'b' }, { _id: undefined, rank: 2 }],
			] as const) {
				const refused = await rejection(
					mine.upsert(loose(filter), loose(values)),
				);
				expect(refused).toBeInstanceOf(TypeError);
				expect((refused as Error).message).toBe(
					'upsert on "posts": "_id" is immutable, and an upsert never ' +
						'writes it. Name it in the filter, which is what an inserted ' +
						'document is seeded from',
				);
			}
			expect(sent).toEqual([]);
		} finally {
			await client.close();
		}
		expect(await stored('posts')).toEqual(before);
	});

	test('upsert takes it in the filter, which seeds the insert', async () => {
		const board = getCollection(t.db, posts);
		await board.sync();
		const chosen = new ObjectId();
		const written = await board.upsert(
			{ _id: chosen },
			{ title: 'a', rank: 1 },
		);
		expect(written._id).toEqual(chosen);
		const again = await board.upsert({ _id: chosen }, { title: 'b', rank: 2 });
		expect(again._id).toEqual(chosen);
		expect(await board.count()).toBe(1);
	});

	test('a caller’s _id is refused before any hook runs', async () => {
		const { ada } = await seed();
		let ran = 0;
		const collection = getCollection(t.db, users, {
			hooks: {
				beforeUpdate: () => {
					ran += 1;
				},
				beforeUpdateMany: () => {
					ran += 1;
				},
			},
		});
		expect(
			await rejectionMessage(
				collection.update(ada._id, loose({ _id: new ObjectId() })),
			),
		).toStartWith(immutable('update', 'users'));
		expect(
			await rejectionMessage(
				collection.updateMany({ _id: ada._id }, loose({ _id: undefined })),
			),
		).toStartWith(immutable('updateMany', 'users'));
		const board = getCollection(t.db, posts, {
			hooks: {
				beforeUpsert: () => {
					ran += 1;
				},
			},
		});
		expect(
			await rejectionMessage(
				board.upsert({ title: 'a' }, loose({ _id: new ObjectId(), rank: 1 })),
			),
		).toStartWith(immutable('upsert', 'posts'));
		expect(ran).toBe(0);
	});

	test('a hook cannot slip one in', async () => {
		const { ada } = await seed();
		const board = getCollection(t.db, posts, {
			hooks: {
				beforeUpsert: (args) => ({
					...args,
					values: loose({ ...args.values, _id: new ObjectId() }),
				}),
			},
		});
		await board.sync();
		const collection = getCollection(t.db, users, {
			hooks: {
				beforeUpdate: (args) => ({
					...args,
					patch: loose({ ...args.patch, $set: { _id: new ObjectId() } }),
				}),
				beforeUpdateMany: (args) => ({
					...args,
					patch: loose({ ...args.patch, _id: new ObjectId() }),
				}),
			},
		});
		expect(
			await rejectionMessage(collection.update(ada._id, { name: 'x' })),
		).toStartWith(immutable('update', 'users'));
		expect(
			await rejectionMessage(
				collection.updateMany({ _id: ada._id }, { name: 'x' }),
			),
		).toStartWith(immutable('updateMany', 'users'));
		expect(
			await rejectionMessage(board.upsert({ title: 'a' }, { rank: 1 })),
		).toStartWith(immutable('upsert', 'posts'));
		expect((await stored('users'))[0]?.name).toBeNull();
		expect(await stored('posts')).toEqual([]);
	});

	test('the driver’s own methods are left alone: the server refuses', async () => {
		const { collection, ada } = await seed();
		for (const send of [
			() =>
				collection.updateOne(
					{ _id: ada._id },
					loose({ $set: { _id: new ObjectId() } }),
				),
			() =>
				collection.raw.updateOne(
					{ _id: ada._id },
					loose({ $set: { _id: new ObjectId() } }),
				),
		]) {
			const refused = await rejection(send());
			expect(refused).not.toBeInstanceOf(TypeError);
			expect((refused as { code?: number }).code).toBe(66);
		}
		// The same `_id` is no change, and the server lets it through.
		await collection.updateOne(
			{ _id: ada._id },
			loose({ $set: { _id: ada._id } }),
		);
		expect((await stored('users'))[0]?._id).toEqual(ada._id);
	});
});
