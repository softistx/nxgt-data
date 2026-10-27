import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { sql } from 'drizzle-orm';
import { createTestDb } from '../../../test/db';
import { rejection } from '../../../test/rejection';
import { posts, tickets } from '../../../test/schema';
import { ArgumentError } from '../../errors/argument-error';
import { NotFoundError, OptimisticLockError } from '../../errors/data-error';
import { withTransaction } from '../transaction/with-transaction';
import { createRepository } from './create-repository';

let t: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
	t = await createTestDb();
});
beforeEach(() => t.reset());
afterAll(() => t.close());

const ada = crypto.randomUUID();
const grace = crypto.randomUUID();

describe('silent updates ({ audit: false })', () => {
	test('update writes the patch and leaves version, updatedAt and updatedBy as they were', async () => {
		const repo = createRepository(t.db, tickets);
		const ticket = await repo.as(ada).create({ slug: 'a', title: 'A' });
		const silent = await repo
			.as(grace)
			.update(ticket.id, { title: 'B' }, { audit: false });
		expect(silent).toEqual({ ...ticket, title: 'B' });
		const again = await repo.getById(ticket.id);
		expect(again).toEqual(silent);
	});

	test('update with audit: true or no option stamps as before', async () => {
		const repo = createRepository(t.db, tickets);
		const ticket = await repo.create({ slug: 'a', title: 'A' });
		const loud = await repo
			.as(grace)
			.update(ticket.id, { title: 'B' }, { audit: true });
		expect(loud).toMatchObject({ version: 1, updatedBy: grace });
		const plain = await repo.update(ticket.id, { title: 'C' }, {});
		expect(plain.version).toBe(2);
	});

	test('updateMany leaves the stamps of every row it writes', async () => {
		const repo = createRepository(t.db, tickets);
		const [a, b] = await repo.as(ada).createMany([
			{ slug: 'a', title: 'A' },
			{ slug: 'b', title: 'B' },
		]);
		if (!a || !b) throw new Error('createMany returned fewer rows');
		const rows = await repo
			.as(grace)
			.updateMany(sql`true`, { title: 'Z' }, { audit: false });
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			const before = row.slug === 'a' ? a : b;
			expect(row).toEqual({ ...before, title: 'Z' });
		}
	});

	test('a column without $onUpdate keeps its updatedAt too', async () => {
		const repo = createRepository(t.db, posts);
		const post = await repo.create({ title: 'a', rank: 1 });
		const silent = await repo.update(post.id, { title: 'b' }, { audit: false });
		expect(silent.updatedAt).toBeNull();
		expect(silent.title).toBe('b');
	});

	test('a stamp the patch sets itself is still written', async () => {
		const repo = createRepository(t.db, tickets);
		const ticket = await repo.create({ slug: 'a', title: 'A' });
		const at = new Date('2001-02-03T04:05:06.789Z');
		const silent = await repo.update(
			ticket.id,
			{ updatedAt: at },
			{ audit: false },
		);
		expect(silent.updatedAt).toEqual(at);
		expect(silent.version).toBe(0);
	});

	test('an expected version is checked, not raised', async () => {
		const repo = createRepository(t.db, tickets);
		const ticket = await repo.create({ slug: 'a', title: 'A' });
		const silent = await repo.update(
			ticket.id,
			{ title: 'B', version: 0 },
			{ audit: false },
		);
		expect(silent.version).toBe(0);
		const error = await rejection(
			repo.update(ticket.id, { title: 'C', version: 5 }, { audit: false }),
		);
		expect(error).toBeInstanceOf(OptimisticLockError);
		expect(await repo.getById(ticket.id)).toMatchObject({ title: 'B' });
	});

	test('a missing row is still a NotFoundError', async () => {
		const repo = createRepository(t.db, tickets);
		await expect(
			repo.update(crypto.randomUUID(), { title: 'x' }, { audit: false }),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test('an empty patch writes nothing and returns the row', async () => {
		const repo = createRepository(t.db, tickets);
		const ticket = await repo.create({ slug: 'a', title: 'A' });
		expect(await repo.update(ticket.id, {}, { audit: false })).toEqual(ticket);
	});

	test('a primary-key column in the patch is still refused', async () => {
		const repo = createRepository(t.db, tickets);
		const ticket = await repo.create({ slug: 'a', title: 'A' });
		const error = await rejection(
			repo.update(ticket.id, { id: crypto.randomUUID() } as never, {
				audit: false,
			}),
		);
		expect(error).toBeInstanceOf(ArgumentError);
	});

	test('runs in the transaction it is given and rolls back with it', async () => {
		const repo = createRepository(t.db, tickets);
		const ticket = await repo.create({ slug: 'a', title: 'A' });
		await rejection(
			withTransaction(t.db, async (tx) => {
				await repo
					.with(tx)
					.update(ticket.id, { title: 'Inside' }, { audit: false });
				expect((await repo.with(tx).getById(ticket.id)).title).toBe('Inside');
				throw new Error('rollback');
			}),
		);
		expect((await repo.getById(ticket.id)).title).toBe('A');
	});

	test('keeps the table checks: a bad value is still refused by the database', async () => {
		const repo = createRepository(t.db, tickets);
		const ticket = await repo.create({ slug: 'a', title: 'A' });
		await repo.create({ slug: 'b', title: 'B' });
		await expect(
			repo.update(ticket.id, { slug: 'b' }, { audit: false }),
		).rejects.toMatchObject({ code: 'CONFLICT' });
	});

	test('a non-boolean audit is an ArgumentError', async () => {
		const repo = createRepository(t.db, tickets);
		const ticket = await repo.create({ slug: 'a', title: 'A' });
		const error = await rejection(
			repo.update(ticket.id, { title: 'B' }, { audit: 'no' } as never),
		);
		expect(error).toBeInstanceOf(ArgumentError);
	});
});
