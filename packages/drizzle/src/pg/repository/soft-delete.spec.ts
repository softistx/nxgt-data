import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { createTestDb } from '../../../test/db';
import { posts, users } from '../../../test/schema';
import { NotFoundError } from '../../errors/data-error';
import { createRepository } from './create-repository';

let t: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
	t = await createTestDb();
});
beforeEach(() => t.reset());
afterAll(() => t.close());

async function seed() {
	const repo = createRepository(t.db, users);
	const [ada, bob] = await repo.createMany([
		{ email: 'ada@example.com', age: 36 },
		{ email: 'bob@example.com', age: 36 },
	]);
	if (!ada || !bob) throw new Error('seed failed');
	return { repo, ada, bob };
}

describe('soft delete', () => {
	test('delete sets deletedAt and returns the row', async () => {
		const { repo, ada } = await seed();
		const deleted = await repo.delete(ada.id);
		expect(deleted.deletedAt).toBeInstanceOf(Date);
		const raw = await t.db.select().from(users);
		expect(raw).toHaveLength(2);
	});

	test('reads leave soft-deleted rows out, unless withDeleted', async () => {
		const { repo, ada } = await seed();
		await repo.delete(ada.id);
		expect(await repo.findById(ada.id)).toBeUndefined();
		await expect(repo.getById(ada.id)).rejects.toBeInstanceOf(NotFoundError);
		expect(await repo.findMany()).toHaveLength(1);
		expect(await repo.count()).toBe(1);
		expect(await repo.exists({ email: 'ada@example.com' })).toBe(false);
		expect(await repo.findFirst({ email: 'ada@example.com' })).toBeUndefined();

		expect((await repo.findById(ada.id, { withDeleted: true }))?.id).toBe(
			ada.id,
		);
		expect(await repo.findMany({ withDeleted: true })).toHaveLength(2);
		expect(await repo.count(undefined, { withDeleted: true })).toBe(2);
		expect(
			await repo.exists({ email: 'ada@example.com' }, { withDeleted: true }),
		).toBe(true);
		expect((await repo.paginate({ withDeleted: true })).total).toBe(2);
		expect((await repo.paginate()).total).toBe(1);
	});

	test('a soft-deleted row cannot be deleted again, or updated', async () => {
		const { repo, ada } = await seed();
		await repo.delete(ada.id);
		await expect(repo.delete(ada.id)).rejects.toBeInstanceOf(NotFoundError);
		await expect(repo.update(ada.id, { name: 'x' })).rejects.toBeInstanceOf(
			NotFoundError,
		);
		expect(await repo.updateMany({ age: 36 }, { name: 'x' })).toHaveLength(1);
	});

	test('deleteMany soft-deletes what matches', async () => {
		const { repo } = await seed();
		const deleted = await repo.deleteMany({ age: 36 });
		expect(deleted).toHaveLength(2);
		expect(deleted.every((u) => u.deletedAt instanceof Date)).toBe(true);
		expect(await repo.count()).toBe(0);
		expect(await repo.deleteMany({ age: 36 })).toHaveLength(0);
	});

	test('restore brings a row back', async () => {
		const { repo, ada } = await seed();
		await repo.delete(ada.id);
		const restored = await repo.restore(ada.id);
		expect(restored.deletedAt).toBeNull();
		expect(await repo.count()).toBe(2);
		await expect(repo.restore(crypto.randomUUID())).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});

	test('hardDelete removes a live or a soft-deleted row', async () => {
		const { repo, ada, bob } = await seed();
		await repo.delete(ada.id);
		expect((await repo.hardDelete(ada.id)).id).toBe(ada.id);
		expect((await repo.hardDelete(bob.id)).id).toBe(bob.id);
		expect(await t.db.select().from(users)).toHaveLength(0);
		await expect(repo.hardDelete(ada.id)).rejects.toBeInstanceOf(NotFoundError);
	});

	test('hardDeleteMany removes what matches, soft-deleted included, and needs a where', async () => {
		const { repo, ada } = await seed();
		await repo.delete(ada.id);
		expect(await repo.hardDeleteMany({ age: 36 })).toHaveLength(2);
		await expect(repo.hardDeleteMany({})).rejects.toThrow(
			'hardDeleteMany needs a where',
		);
	});

	test('softDelete: false makes delete real', async () => {
		await seed();
		const repo = createRepository(t.db, users, { softDelete: false });
		const [first] = await repo.findMany();
		if (!first) throw new Error('seed failed');
		await repo.delete(first.id);
		expect(await t.db.select().from(users)).toHaveLength(1);
		expect(await repo.findMany({ where: { deletedAt: null } })).toHaveLength(1);
	});

	test('softDelete: true on a table without deletedAt throws at creation', () => {
		expect(() =>
			createRepository(t.db, posts, { softDelete: true as unknown as false }),
		).toThrow('softDelete needs a "deletedAt" column');
	});
});
