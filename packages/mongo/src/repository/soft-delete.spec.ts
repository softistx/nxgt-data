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
import { createRepository } from './create-repository';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo();
}, 120_000);
beforeEach(() => t.reset());
afterAll(() => t.stop());

async function seed() {
	const repo = createRepository(t.db, users);
	await repo.sync();
	const [ada, bob] = await repo.createMany([
		{ email: 'ada@example.com', age: 36 },
		{ email: 'bob@example.com', age: 36 },
	]);
	if (!ada || !bob) throw new Error('seed failed');
	return { repo, ada, bob };
}

describe('soft delete', () => {
	test('delete sets deletedAt and keeps the document', async () => {
		const { repo, ada } = await seed();
		const deleted = await repo.delete(ada._id);
		expect(deleted.deletedAt).toBeInstanceOf(Date);
		expect(await t.db.collection('users').countDocuments()).toBe(2);
	});

	test('reads leave soft-deleted documents out, unless withDeleted', async () => {
		const { repo, ada } = await seed();
		await repo.delete(ada._id);

		expect(await repo.findById(ada._id)).toBeUndefined();
		await expect(repo.getById(ada._id)).rejects.toBeInstanceOf(NotFoundError);
		expect(await repo.findMany()).toHaveLength(1);
		expect(await repo.count()).toBe(1);
		expect(await repo.exists({ email: 'ada@example.com' })).toBe(false);
		expect(await repo.findFirst({ email: 'ada@example.com' })).toBeUndefined();

		expect((await repo.findById(ada._id, { withDeleted: true }))?._id).toEqual(
			ada._id,
		);
		expect(await repo.findMany({ withDeleted: true })).toHaveLength(2);
		expect(await repo.count(undefined, { withDeleted: true })).toBe(2);
		expect(
			await repo.exists({ email: 'ada@example.com' }, { withDeleted: true }),
		).toBe(true);
		expect(
			(
				await repo.findFirst(
					{ email: 'ada@example.com' },
					{ withDeleted: true },
				)
			)?.email,
		).toBe('ada@example.com');
		expect((await repo.paginate({ withDeleted: true })).total).toBe(2);
		expect((await repo.paginate()).total).toBe(1);
	});

	test('a soft-deleted document cannot be deleted again, or updated', async () => {
		const { repo, ada } = await seed();
		await repo.delete(ada._id);
		await expect(repo.delete(ada._id)).rejects.toBeInstanceOf(NotFoundError);
		await expect(repo.update(ada._id, { name: 'x' })).rejects.toBeInstanceOf(
			NotFoundError,
		);
		expect(await repo.updateMany({ age: 36 }, { name: 'x' })).toBe(1);
	});

	test('deleteMany soft-deletes what matches', async () => {
		const { repo } = await seed();
		expect(await repo.deleteMany({ age: 36 })).toBe(2);
		expect(await repo.count()).toBe(0);
		expect(await repo.count(undefined, { withDeleted: true })).toBe(2);
		expect(await repo.deleteMany({ age: 36 })).toBe(0);
	});

	test('restore brings a document back, and stamps nothing new', async () => {
		const { repo, ada } = await seed();
		const actor = new ObjectId();
		await repo.as(actor).delete(ada._id);
		expect(
			(await repo.findById(ada._id, { withDeleted: true }))?.deletedBy,
		).toEqual(actor);

		const restored = await repo.restore(ada._id);
		expect(restored.deletedAt).toBeNull();
		expect(restored.deletedBy).toBeNull();
		expect(await repo.count()).toBe(2);
		await expect(repo.restore(new ObjectId())).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});

	test('restore leaves a document that was never deleted alone', async () => {
		const { repo, bob } = await seed();
		expect((await repo.restore(bob._id)).deletedAt).toBeNull();
		expect(await repo.count()).toBe(2);
	});

	test('hardDelete removes a live or a soft-deleted document', async () => {
		const { repo, ada, bob } = await seed();
		await repo.delete(ada._id);
		expect((await repo.hardDelete(ada._id))._id).toEqual(ada._id);
		expect((await repo.hardDelete(bob._id))._id).toEqual(bob._id);
		expect(await t.db.collection('users').countDocuments()).toBe(0);
		await expect(repo.hardDelete(ada._id)).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});

	test('hardDeleteMany removes what matches, soft-deleted included', async () => {
		const { repo, ada } = await seed();
		await repo.delete(ada._id);
		expect(await repo.hardDeleteMany({ age: 36 })).toBe(2);
		await expect(repo.hardDeleteMany({})).rejects.toThrow(
			'hardDeleteMany needs a filter',
		);
	});

	test('softDelete: false makes delete real', async () => {
		await seed();
		const repo = createRepository(t.db, users, { softDelete: false });
		const [first] = await repo.findMany();
		if (!first) throw new Error('seed failed');
		await repo.delete(first._id);
		expect(await t.db.collection('users').countDocuments()).toBe(1);
	});

	test('softDelete: true on a collection without deletedAt throws at creation', async () => {
		const { posts } = await import('../../test/schema');
		expect(() => createRepository(t.db, posts, { softDelete: true })).toThrow(
			'softDelete needs a "deletedAt" field',
		);
	});
});
