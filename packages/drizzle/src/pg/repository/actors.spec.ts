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
import { posts, teams, tickets } from '../../../test/schema';
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

describe('actor stamps', () => {
	test('create stamps createdBy and updatedBy; nobody acting stamps nothing', async () => {
		const repo = createRepository(t.db, tickets);
		const anonymous = await repo.create({ slug: 'a', title: 'A' });
		expect(anonymous).toMatchObject({ createdBy: null, updatedBy: null });
		const [one, two] = await repo.as(ada).createMany([
			{ slug: 'b', title: 'B' },
			{ slug: 'c', title: 'C' },
		]);
		expect(one).toMatchObject({ createdBy: ada, updatedBy: ada });
		expect(two).toMatchObject({ createdBy: ada, updatedBy: ada });
	});

	test('a stamp the values give is kept: an import keeps its author', async () => {
		const ticket = await createRepository(t.db, tickets)
			.as(ada)
			.create({ slug: 'a', title: 'A', createdBy: grace });
		expect(ticket).toMatchObject({ createdBy: grace, updatedBy: ada });
	});

	test('update and updateMany stamp updatedBy, never createdBy', async () => {
		const repo = createRepository(t.db, tickets);
		const ticket = await repo.as(ada).create({ slug: 'a', title: 'A' });
		const updated = await repo.as(grace).update(ticket.id, { title: 'B' });
		expect(updated).toMatchObject({ createdBy: ada, updatedBy: grace });
		const [many] = await repo.as(ada).updateMany({ slug: 'a' }, { title: 'C' });
		expect(many).toMatchObject({ createdBy: ada, updatedBy: ada });
	});

	test('an empty patch stamps nobody', async () => {
		const repo = createRepository(t.db, tickets);
		const ticket = await repo.create({ slug: 'a', title: 'A' });
		expect(await repo.as(ada).update(ticket.id, {})).toEqual(ticket);
	});

	test('a soft delete stamps deletedBy, and restore clears it', async () => {
		const repo = createRepository(t.db, tickets).as(ada);
		const ticket = await repo.create({ slug: 'a', title: 'A' });
		const deleted = await repo.delete(ticket.id);
		expect(deleted).toMatchObject({ deletedBy: ada, updatedBy: ada });
		expect(deleted.deletedAt).toBeInstanceOf(Date);
		const restored = await createRepository(t.db, tickets)
			.as(grace)
			.restore(ticket.id);
		expect(restored).toMatchObject({
			deletedAt: null,
			deletedBy: null,
			updatedBy: grace,
		});
		const [many] = await repo.deleteMany({ slug: 'a' });
		expect(many).toMatchObject({ deletedBy: ada });
	});

	test('the actor option is the same as as()', async () => {
		const repo = createRepository(t.db, tickets, { actor: ada });
		expect(await repo.create({ slug: 'a', title: 'A' })).toMatchObject({
			createdBy: ada,
		});
	});

	test('as() leaves the repository it was called on alone, and survives with()', async () => {
		const repo = createRepository(t.db, tickets);
		const acting = repo.as(ada);
		await withTransaction(t.db, async (tx) => {
			const ticket = await acting.with(tx).create({ slug: 'a', title: 'A' });
			expect(ticket.createdBy).toBe(ada);
			const plain = await repo.with(tx).create({ slug: 'b', title: 'B' });
			expect(plain.createdBy).toBeNull();
		});
	});

	test('as() refuses no actor, and a table with nothing to stamp', () => {
		const repo = createRepository(t.db, tickets);
		for (const actor of [undefined, null]) {
			let error: unknown;
			try {
				repo.as(actor as never);
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(ArgumentError);
			expect(error).toHaveProperty('argument', 'actor');
			expect((error as Error).message).toBe(
				`as on "tickets": the actor is ${String(actor)}. Pass who is writing, or use the repository without as()`,
			);
		}
		expect(() =>
			createRepository(t.db, tickets, { actor: null as never }),
		).toThrow(
			'createRepository on "tickets": the actor is null. Pass who is writing, or use the repository without as()',
		);
		expect(() =>
			createRepository(t.db, teams, { actor: ada as never }),
		).toThrow(
			'createRepository on "teams": the table has no createdBy, updatedBy or deletedBy column to stamp',
		);
		const plain = createRepository(t.db, teams) as unknown as {
			as(actor: unknown): unknown;
		};
		expect(() => plain.as(ada)).toThrow(
			'as on "teams": the table has no createdBy, updatedBy or deletedBy column to stamp',
		);
	});
});

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

	test('a non-boolean audit is an ArgumentError, on update and updateMany', async () => {
		const repo = createRepository(t.db, tickets);
		const ticket = await repo.create({ slug: 'a', title: 'A' });
		const one = await rejection(
			repo.update(ticket.id, { title: 'B' }, { audit: 'no' } as never),
		);
		expect(one).toBeInstanceOf(ArgumentError);
		expect((one as Error).message).toBe(
			'update on "tickets": "audit" must be a boolean, not a string',
		);
		const many = await rejection(
			repo.updateMany(sql`true`, { title: 'B' }, { audit: 0 } as never),
		);
		expect(many).toBeInstanceOf(ArgumentError);
		expect((await repo.getById(ticket.id)).title).toBe('A');
	});

	test('an option other than audit is refused: session and tx point to with(tx)', async () => {
		const repo = createRepository(t.db, tickets);
		const ticket = await repo.create({ slug: 'a', title: 'A' });
		const session = await rejection(
			repo.update(ticket.id, { title: 'B' }, { session: 1 } as never),
		);
		expect(session).toBeInstanceOf(ArgumentError);
		expect((session as Error).message).toContain('with(tx)');
		const tx = await rejection(
			repo.updateMany(sql`true`, { title: 'B' }, { tx: {} } as never),
		);
		expect(tx).toBeInstanceOf(ArgumentError);
		expect((tx as Error).message).toBe(
			'updateMany on "tickets": "tx" is not an option. Bind a transaction with with(tx)',
		);
		const other = await rejection(
			repo.update(ticket.id, { title: 'B' }, { silent: true } as never),
		);
		expect((other as Error).message).toContain('The only option is audit');
		expect((await repo.getById(ticket.id)).title).toBe('A');
	});

	test('updateMany keeps each row its own updatedAt, a $onUpdate column included', async () => {
		const repo = createRepository(t.db, tickets);
		const [a, b] = await repo.createMany([
			{ slug: 'a', title: 'A' },
			{ slug: 'b', title: 'B' },
		]);
		if (!a || !b) throw new Error('createMany returned fewer rows');
		const loud = await repo.update(a.id, { title: 'A2' });
		expect(loud.updatedAt.getTime()).toBeGreaterThanOrEqual(
			b.updatedAt.getTime(),
		);
		const rows = await repo.updateMany(
			sql`true`,
			{ title: 'Z' },
			{ audit: false },
		);
		const byId = new Map(rows.map((row) => [row.id, row]));
		expect(byId.get(a.id)?.updatedAt).toEqual(loud.updatedAt);
		expect(byId.get(b.id)?.updatedAt).toEqual(b.updatedAt);
		expect(byId.get(a.id)?.version).toBe(1);
		expect(byId.get(b.id)?.version).toBe(0);
	});

	test('updateMany runs in the transaction it is given and rolls back with it', async () => {
		const repo = createRepository(t.db, tickets);
		const ticket = await repo.create({ slug: 'a', title: 'A' });
		await rejection(
			withTransaction(t.db, async (tx) => {
				await repo
					.with(tx)
					.updateMany(sql`true`, { title: 'Inside' }, { audit: false });
				expect((await repo.with(tx).getById(ticket.id)).title).toBe('Inside');
				throw new Error('rollback');
			}),
		);
		expect((await repo.getById(ticket.id)).title).toBe('A');
	});

	test('updateMany still refuses a primary-key column in the patch', async () => {
		const repo = createRepository(t.db, tickets);
		await repo.create({ slug: 'a', title: 'A' });
		const error = await rejection(
			repo.updateMany(sql`true`, { id: crypto.randomUUID() } as never, {
				audit: false,
			}),
		);
		expect(error).toBeInstanceOf(ArgumentError);
	});
});
