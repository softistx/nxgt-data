import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { ObjectId } from 'mongodb';
import { rejection, rejectionMessage } from '../../test/rejection';
import { posts, tickets, users } from '../../test/schema';
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

	test('a version in the patch writes only while it still matches', async () => {
		const { collection, ada } = await seed();
		const updated = await collection.update(ada._id, {
			name: 'Ada',
			version: 0,
		});
		expect(updated.version).toBe(1);

		const error = await collection
			.update(ada._id, { name: 'Stale', version: 0 })
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

		await collection.update(first._id, {
			name: 'First',
			version: first.version,
		});
		expect(
			await rejection(
				collection.update(second._id, {
					name: 'Second',
					version: second.version,
				}),
			),
		).toBeInstanceOf(OptimisticLockError);
		expect((await collection.getById(ada._id)).name).toBe('First');
	});

	test('an _id that is not there is a NotFoundError, not a lock failure', async () => {
		const { collection } = await seed();
		expect(
			await rejection(
				collection.update(new ObjectId(), { name: 'x', version: 0 }),
			),
		).toBeInstanceOf(NotFoundError);
	});

	test('an expected version needs a version field, and the lock', async () => {
		const collection = getCollection(t.db, posts);
		await collection.sync();
		const post = await collection.create({ title: 'a', rank: 1 });
		// The first is a compile error too. The second is not: the types see
		// the definition, not the options a collection was opened with.
		expect(
			await rejectionMessage(
				// @ts-expect-error posts have no version field
				collection.update(post._id, { title: 'b', version: 0 }),
			),
		).toContain('has no field "version"');
		const { ada } = await seed();
		expect(
			await rejectionMessage(
				getCollection(t.db, users, { optimisticLock: false }).update(ada._id, {
					name: 'x',
					version: 0,
				}),
			),
		).toContain('without its optimistic lock');
		expect(() =>
			// @ts-expect-error posts have no version field
			getCollection(t.db, posts, { optimisticLock: true }),
		).toThrow('optimisticLock needs a version field');
	});

	test('the expected version goes by the name the collection gives it', async () => {
		const collection = getCollection(t.db, tickets);
		await collection.sync();
		const ticket = await collection.create({ subject: 'a' });
		const updated = await collection.update(ticket._id, {
			subject: 'b',
			revision: 0,
		});
		expect(updated.revision).toBe(1);
		expect(
			await rejection(
				collection.update(ticket._id, { subject: 'c', revision: 0 }),
			),
		).toBeInstanceOf(OptimisticLockError);
		expect(
			await rejectionMessage(
				// @ts-expect-error the version is called `revision` here
				collection.update(ticket._id, { subject: 'c', version: 1 }),
			),
		).toContain('has no field "version"');
	});

	test('the expected version is a whole number', async () => {
		const { collection, ada } = await seed();
		for (const version of [-1, 1.5, '1']) {
			expect(
				await rejectionMessage(
					collection.update(ada._id, { name: 'x', version: version as never }),
				),
			).toContain('must be a whole number');
		}
	});

	test('updateMany takes no expected version', async () => {
		const { collection } = await seed();
		expect(
			await rejectionMessage(
				// @ts-expect-error one version cannot stand for many documents
				collection.updateMany({ name: null }, { name: 'x', version: 0 }),
			),
		).toContain('"version" is kept by "users" itself');
	});

	test('optimisticLock: false leaves the version alone', async () => {
		const { ada } = await seed();
		const collection = getCollection(t.db, users, { optimisticLock: false });
		expect((await collection.update(ada._id, { name: 'Ada' })).version).toBe(0);
	});
});
