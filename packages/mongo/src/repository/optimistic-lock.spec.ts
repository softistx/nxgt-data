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
	const ada = await repo.create({ email: 'ada@example.com' });
	return { repo, ada };
}

describe('optimistic locking', () => {
	test('every update raises the version', async () => {
		const { repo, ada } = await seed();
		expect(ada.version).toBe(0);
		expect((await repo.update(ada._id, { name: 'Ada' })).version).toBe(1);
		expect((await repo.update(ada._id, { name: 'A' })).version).toBe(2);
		expect((await repo.delete(ada._id)).version).toBe(3);
		expect((await repo.restore(ada._id)).version).toBe(4);
	});

	test('expectedVersion writes only while the version still matches', async () => {
		const { repo, ada } = await seed();
		const updated = await repo.update(
			ada._id,
			{ name: 'Ada' },
			{ expectedVersion: 0 },
		);
		expect(updated.version).toBe(1);

		const error = await repo
			.update(ada._id, { name: 'Stale' }, { expectedVersion: 0 })
			.catch((e) => e);
		expect(error).toBeInstanceOf(OptimisticLockError);
		expect(error.code).toBe('OPTIMISTIC_LOCK');
		expect(error.expectedVersion).toBe(0);
		expect(error.actualVersion).toBe(1);
		expect(error.collection).toBe('users');
		expect(error.message).toContain('it changed since it was read');
		// Nothing was written.
		expect((await repo.getById(ada._id)).name).toBe('Ada');
	});

	test('the second of two readers loses, and nothing is lost silently', async () => {
		const { repo, ada } = await seed();
		const first = await repo.getById(ada._id);
		const second = await repo.getById(ada._id);

		await repo.update(
			first._id,
			{ name: 'First' },
			{
				expectedVersion: first.version,
			},
		);
		await expect(
			repo.update(
				second._id,
				{ name: 'Second' },
				{
					expectedVersion: second.version,
				},
			),
		).rejects.toBeInstanceOf(OptimisticLockError);
		expect((await repo.getById(ada._id)).name).toBe('First');
	});

	test('an _id that is not there is a NotFoundError, not a lock failure', async () => {
		const { repo } = await seed();
		await expect(
			repo.update(new ObjectId(), { name: 'x' }, { expectedVersion: 0 }),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test('expectedVersion needs a version field', async () => {
		const repo = createRepository(t.db, posts);
		await repo.sync();
		const post = await repo.create({ title: 'a', rank: 1 });
		await expect(
			repo.update(post._id, { title: 'b' }, { expectedVersion: 0 }),
		).rejects.toThrow('expectedVersion needs a "version" field');
		expect(() =>
			createRepository(t.db, posts, { optimisticLock: true }),
		).toThrow('optimisticLock needs a "version" field');
	});

	test('optimisticLock: false leaves the version alone', async () => {
		const { ada } = await seed();
		const repo = createRepository(t.db, users, { optimisticLock: false });
		expect((await repo.update(ada._id, { name: 'Ada' })).version).toBe(0);
	});
});
