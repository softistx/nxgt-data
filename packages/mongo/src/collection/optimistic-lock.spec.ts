import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { ObjectId } from 'mongodb';
import { posts, users } from '../../test/schema';
import { startMongo, type TestServer } from '../../test/server';
import { NotFoundError, OptimisticLockError } from '../errors/data-error';
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

describe('optimistic locking', () => {
	test('every update raises the version', async () => {
		const { collection, ada } = await seed();
		expect(ada.version).toBe(0);
		expect((await collection.update(ada._id, { name: 'Ada' })).version).toBe(1);
		expect((await collection.update(ada._id, { name: 'A' })).version).toBe(2);
		expect((await collection.delete(ada._id)).version).toBe(3);
		expect((await collection.restore(ada._id)).version).toBe(4);
	});

	test('expectedVersion writes only while the version still matches', async () => {
		const { collection, ada } = await seed();
		const updated = await collection.update(
			ada._id,
			{ name: 'Ada' },
			{ expectedVersion: 0 },
		);
		expect(updated.version).toBe(1);

		const error = await collection
			.update(ada._id, { name: 'Stale' }, { expectedVersion: 0 })
			.catch((e) => e);
		expect(error).toBeInstanceOf(OptimisticLockError);
		expect(error.code).toBe('OPTIMISTIC_LOCK');
		expect(error.expectedVersion).toBe(0);
		expect(error.actualVersion).toBe(1);
		expect(error.collection).toBe('users');
		expect(error.message).toContain('it changed since it was read');
		// Nothing was written.
		expect((await collection.getById(ada._id)).name).toBe('Ada');
	});

	test('the second of two readers loses, and nothing is lost silently', async () => {
		const { collection, ada } = await seed();
		const first = await collection.getById(ada._id);
		const second = await collection.getById(ada._id);

		await collection.update(
			first._id,
			{ name: 'First' },
			{
				expectedVersion: first.version,
			},
		);
		await expect(
			collection.update(
				second._id,
				{ name: 'Second' },
				{
					expectedVersion: second.version,
				},
			),
		).rejects.toBeInstanceOf(OptimisticLockError);
		expect((await collection.getById(ada._id)).name).toBe('First');
	});

	test('an _id that is not there is a NotFoundError, not a lock failure', async () => {
		const { collection } = await seed();
		await expect(
			collection.update(new ObjectId(), { name: 'x' }, { expectedVersion: 0 }),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test('expectedVersion needs a version field', async () => {
		const collection = getCollection(t.db, posts);
		await collection.sync();
		const post = await collection.create({ title: 'a', rank: 1 });
		await expect(
			collection.update(post._id, { title: 'b' }, { expectedVersion: 0 }),
		).rejects.toThrow('expectedVersion needs a "version" field');
		expect(() => getCollection(t.db, posts, { optimisticLock: true })).toThrow(
			'optimisticLock needs a "version" field',
		);
	});

	test('optimisticLock: false leaves the version alone', async () => {
		const { ada } = await seed();
		const collection = getCollection(t.db, users, { optimisticLock: false });
		expect((await collection.update(ada._id, { name: 'Ada' })).version).toBe(0);
	});
});
