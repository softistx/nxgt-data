import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { ObjectId } from 'mongodb';
import { users } from '../../test/schema';
import { startMongo, type TestServer } from '../../test/server';
import { NotFoundError } from '../errors/data-error';
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
	const [ada, bob] = await collection.createMany([
		{ email: 'ada@example.com', age: 36 },
		{ email: 'bob@example.com', age: 36 },
	]);
	if (!ada || !bob) throw new Error('seed failed');
	return { collection, ada, bob };
}

describe('soft delete', () => {
	test('delete sets deletedAt and keeps the document', async () => {
		const { collection, ada } = await seed();
		const deleted = await collection.delete(ada._id);
		expect(deleted.deletedAt).toBeInstanceOf(Date);
		expect(await t.db.collection('users').countDocuments()).toBe(2);
	});

	test('reads leave soft-deleted documents out, unless withDeleted', async () => {
		const { collection, ada } = await seed();
		await collection.delete(ada._id);

		expect(await collection.findById(ada._id)).toBeUndefined();
		await expect(collection.getById(ada._id)).rejects.toBeInstanceOf(
			NotFoundError,
		);
		expect(await collection.findMany()).toHaveLength(1);
		expect(await collection.count()).toBe(1);
		expect(await collection.exists({ email: 'ada@example.com' })).toBe(false);
		expect(
			await collection.findFirst({ email: 'ada@example.com' }),
		).toBeUndefined();

		expect(
			(await collection.findById(ada._id, { withDeleted: true }))?._id,
		).toEqual(ada._id);
		expect(await collection.findMany({ withDeleted: true })).toHaveLength(2);
		expect(await collection.count(undefined, { withDeleted: true })).toBe(2);
		expect(
			await collection.exists(
				{ email: 'ada@example.com' },
				{ withDeleted: true },
			),
		).toBe(true);
		expect(
			(
				await collection.findFirst(
					{ email: 'ada@example.com' },
					{ withDeleted: true },
				)
			)?.email,
		).toBe('ada@example.com');
		expect((await collection.paginate({ withDeleted: true })).total).toBe(2);
		expect((await collection.paginate()).total).toBe(1);
	});

	test('a soft-deleted document cannot be deleted again, or updated', async () => {
		const { collection, ada } = await seed();
		await collection.delete(ada._id);
		await expect(collection.delete(ada._id)).rejects.toBeInstanceOf(
			NotFoundError,
		);
		await expect(
			collection.update(ada._id, { name: 'x' }),
		).rejects.toBeInstanceOf(NotFoundError);
		expect(await collection.updateMany({ age: 36 }, { name: 'x' })).toBe(1);
	});

	test('deleteMany soft-deletes what matches', async () => {
		const { collection } = await seed();
		expect(await collection.deleteMany({ age: 36 })).toBe(2);
		expect(await collection.count()).toBe(0);
		expect(await collection.count(undefined, { withDeleted: true })).toBe(2);
		expect(await collection.deleteMany({ age: 36 })).toBe(0);
	});

	test('restore brings a document back, and stamps nothing new', async () => {
		const { collection, ada } = await seed();
		const actor = new ObjectId();
		await collection.as(actor).delete(ada._id);
		expect(
			(await collection.findById(ada._id, { withDeleted: true }))?.deletedBy,
		).toEqual(actor);

		const restored = await collection.restore(ada._id);
		expect(restored.deletedAt).toBeNull();
		expect(restored.deletedBy).toBeNull();
		expect(await collection.count()).toBe(2);
		await expect(collection.restore(new ObjectId())).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});

	test('restore leaves a document that was never deleted alone', async () => {
		const { collection, bob } = await seed();
		expect((await collection.restore(bob._id)).deletedAt).toBeNull();
		expect(await collection.count()).toBe(2);
	});

	test('hardDelete removes a live or a soft-deleted document', async () => {
		const { collection, ada, bob } = await seed();
		await collection.delete(ada._id);
		expect((await collection.hardDelete(ada._id))._id).toEqual(ada._id);
		expect((await collection.hardDelete(bob._id))._id).toEqual(bob._id);
		expect(await t.db.collection('users').countDocuments()).toBe(0);
		await expect(collection.hardDelete(ada._id)).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});

	test('hardDeleteMany removes what matches, soft-deleted included', async () => {
		const { collection, ada } = await seed();
		await collection.delete(ada._id);
		expect(await collection.hardDeleteMany({ age: 36 })).toBe(2);
		await expect(collection.hardDeleteMany({})).rejects.toThrow(
			'hardDeleteMany needs a filter',
		);
	});

	test('softDelete: false makes delete real', async () => {
		await seed();
		const collection = getCollection(t.db, users, { softDelete: false });
		const [first] = await collection.findMany();
		if (!first) throw new Error('seed failed');
		await collection.delete(first._id);
		expect(await t.db.collection('users').countDocuments()).toBe(1);
	});

	test('softDelete: true on a collection without deletedAt throws at creation', async () => {
		const { posts } = await import('../../test/schema');
		expect(() => getCollection(t.db, posts, { softDelete: true })).toThrow(
			'softDelete needs a "deletedAt" field',
		);
	});
});
