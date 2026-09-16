import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { posts, users } from '../../test/schema';
import { startMongo, type TestServer } from '../../test/server';
import { withTransaction } from '../transaction/with-transaction';
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
	await collection.createMany([
		{ email: 'ada@example.com', age: 36 },
		{ email: 'bob@example.com', age: 36 },
	]);
	return collection;
}

describe('the driver’s own methods', () => {
	test('are on the collection, without going through anything', async () => {
		const collection = await seed();

		const grouped = await collection
			.aggregate([{ $group: { _id: '$age', n: { $sum: 1 } } }])
			.toArray();
		expect(grouped).toEqual([{ _id: 36, n: 2 }] as never);

		expect((await collection.distinct('email')).sort()).toEqual([
			'ada@example.com',
			'bob@example.com',
		]);
		expect(await collection.estimatedDocumentCount()).toBe(2);
		expect(
			await collection.findOne({ email: 'ada@example.com' }),
		).toMatchObject({ age: 36 });
		expect(collection.collectionName).toBe('users');
		expect(collection.dbName).toBe(t.db.databaseName);
		expect(await collection.indexExists('users_email_unique')).toBe(true);
	});

	test('a method the driver has is seen by `in`', async () => {
		const collection = await seed();
		expect('aggregate' in collection).toBe(true);
		expect('watch' in collection).toBe(true);
		// And so are ours.
		expect('paginate' in collection).toBe(true);
		expect('nothing_like_this' in collection).toBe(false);
	});
});

describe('the three names both define', () => {
	test('are ours, and the driver’s are on raw', async () => {
		const collection = await seed();

		// Ours: a number, and a filter is required.
		expect(await collection.updateMany({ age: 36 }, { name: 'x' })).toBe(2);
		expect(await collection.count()).toBe(2);
		expect(await collection.deleteMany({ age: 36 })).toBe(2);
		// Soft-deleted, so they are still there for the driver.
		expect(await collection.raw.count()).toBe(2);

		// The driver's: its own result shape, and no filter is required.
		const result = await collection.raw.updateMany(
			{},
			{ $set: { name: 'straight through' } },
		);
		expect(result.modifiedCount).toBe(2);
		expect(result.acknowledged).toBe(true);
	});

	test('ours still refuse an empty filter, the driver’s does not', async () => {
		const collection = await seed();
		await expect(collection.updateMany({}, { name: 'x' })).rejects.toThrow(
			'updateMany needs a filter',
		);
		// The escape hatch is explicit, which is the point.
		expect(
			(await collection.raw.updateMany({}, { $set: { name: 'x' } }))
				.modifiedCount,
		).toBe(2);
	});
});

describe('getCollection’s source', () => {
	test('takes a Db', async () => {
		const collection = getCollection(t.db, posts);
		expect(collection.db.databaseName).toBe(t.db.databaseName);
		expect(collection.dbName).toBe(t.db.databaseName);
	});

	test('takes a client, with the database named', async () => {
		const collection = getCollection(t.client, users, {
			db: t.db.databaseName,
		});
		await collection.sync();
		await collection.create({ email: 'ada@example.com' });
		expect(await collection.count()).toBe(1);
		// It is the same database the Db-bound one reads.
		expect(await getCollection(t.db, users).count()).toBe(1);
	});

	test('takes a client alone, and uses the URI’s database', () => {
		const collection = getCollection(t.client, posts);
		expect(typeof collection.dbName).toBe('string');
		expect(collection.dbName.length).toBeGreaterThan(0);
	});

	test('refuses a Db and a db option that disagree', () => {
		expect(() => getCollection(t.db, users, { db: 'somewhere-else' })).toThrow(
			'Pass the client, or the database you mean',
		);
	});
});

describe('withSession', () => {
	test('binds our methods, and the driver’s take the session their own way', async () => {
		const collection = await seed();

		await withTransaction(t.client, async (session) => {
			const bound = collection.withSession(session);
			await bound.create({ email: 'inside@example.com' });

			// Ours, bound: the write is in the transaction and visible to it.
			expect(await bound.count()).toBe(3);

			// A driver method reached through the collection is NOT bound: it
			// takes its session the driver's way, in its options. Without one it
			// reads outside the transaction, where the write is not there yet.
			expect(await bound.countDocuments({})).toBe(2);
			expect(await bound.countDocuments({}, { session })).toBe(3);
			expect(await bound.raw.countDocuments({}, { session })).toBe(3);
			// `estimatedDocumentCount` is not a witness of any of this: it reads
			// the storage engine's metadata rather than the documents, so it is
			// not transactional and already counts the uncommitted insert.
		});

		expect(await collection.count()).toBe(3);
	});

	test('gives back a new collection, and leaves the first alone', async () => {
		const collection = await seed();
		await withTransaction(t.client, async (session) => {
			const bound = collection.withSession(session);
			expect(bound.session).toBe(session);
			expect(collection.session).toBeUndefined();
			// The unbound one writes outside the transaction.
			await collection.create({ email: 'outside@example.com' });
			await session.abortTransaction();
		});
		expect(await collection.count()).toBe(3);
	});
});
