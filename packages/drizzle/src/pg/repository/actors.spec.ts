import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { createTestDb } from '../../../test/db';
import { teams, tickets } from '../../../test/schema';
import { ArgumentError } from '../../errors/argument-error';
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
