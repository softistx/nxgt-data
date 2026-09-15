import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { TransactionRollbackError } from 'drizzle-orm';
import { createTestDb } from '../../../test/db';
import { teams } from '../../../test/schema';
import { ConflictError } from '../../errors/data-error';
import { createRepository } from '../repository/create-repository';
import { withTransaction } from './with-transaction';

let t: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
	t = await createTestDb();
});
beforeEach(() => t.reset());
afterAll(() => t.close());

const names = async () =>
	(await t.db.select().from(teams).orderBy(teams.id)).map((row) => row.name);

describe('withTransaction', () => {
	test('commits when fn resolves, and returns its value', async () => {
		const repo = createRepository(t.db, teams);
		const created = await withTransaction(t.db, async (tx) => {
			return repo.with(tx).create({ name: 'Core' });
		});
		expect(created.name).toBe('Core');
		expect(await names()).toEqual(['Core']);
	});

	test('rolls back when fn throws, and rethrows', async () => {
		const repo = createRepository(t.db, teams);
		const error = new Error('stop');
		await expect(
			withTransaction(t.db, async (tx) => {
				await repo.with(tx).create({ name: 'Core' });
				throw error;
			}),
		).rejects.toBe(error);
		expect(await names()).toEqual([]);
	});

	test('turns a database error into a DataError, and rolls back', async () => {
		await expect(
			withTransaction(t.db, async (tx) => {
				await tx.insert(teams).values({ name: 'Core' });
				await tx.insert(teams).values({ name: 'Core' });
			}),
		).rejects.toBeInstanceOf(ConflictError);
		expect(await names()).toEqual([]);
	});

	test("lets Drizzle's rollback through", async () => {
		await expect(
			withTransaction(t.db, async (tx) => {
				await tx.insert(teams).values({ name: 'Core' });
				tx.rollback();
			}),
		).rejects.toBeInstanceOf(TransactionRollbackError);
		expect(await names()).toEqual([]);
	});

	test('nested, it is a savepoint: the inner failure alone is rolled back', async () => {
		await withTransaction(t.db, async (tx) => {
			await tx.insert(teams).values({ name: 'Outer' });
			await withTransaction(tx, async (inner) => {
				await inner.insert(teams).values({ name: 'Inner' });
				throw new Error('inner fails');
			}).catch(() => {});
			await withTransaction(tx, async (inner) => {
				await inner.insert(teams).values({ name: 'Kept' });
			});
		});
		expect(await names()).toEqual(['Outer', 'Kept']);
	});

	test('an outer failure rolls back a committed savepoint too', async () => {
		await withTransaction(t.db, async (tx) => {
			await withTransaction(tx, async (inner) => {
				await inner.insert(teams).values({ name: 'Inner' });
			});
			throw new Error('outer fails');
		}).catch(() => {});
		expect(await names()).toEqual([]);
	});

	test('takes an isolation level at the top, and refuses one on a savepoint', async () => {
		const level = await withTransaction(
			t.db,
			async (tx) => {
				const result = await tx.execute<{ transaction_isolation: string }>(
					'show transaction_isolation',
				);
				await expect(
					withTransaction(tx, async () => {}, {
						isolationLevel: 'serializable',
					}),
				).rejects.toThrow('savepoint');
				return result.rows[0]?.transaction_isolation;
			},
			{ isolationLevel: 'serializable' },
		);
		expect(level).toBe('serializable');
	});
});
