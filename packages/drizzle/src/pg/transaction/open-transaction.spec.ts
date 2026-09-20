import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { createTestDb } from '../../../test/db';
import { teams, users } from '../../../test/schema';
import { ArgumentError } from '../../errors/argument-error';
import { DataError } from '../../errors/data-error';
import { createRepository } from '../repository/create-repository';
import { withTransaction } from './with-transaction';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let t: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
	t = await createTestDb();
});
beforeEach(() => t.reset());
afterAll(() => t.close());

/**
 * What `promise` did within `ms` — settled, or still waiting.
 *
 * The rejection is taken here, where the promise is made, and never later: a
 * call this file leaves hanging is settled by `t.close()` long after its test
 * ended, and an unhandled rejection ends the process in Bun.
 */
function within(promise: Promise<unknown>, ms: number) {
	let outcome = 'waiting';
	promise.then(
		() => {
			outcome = 'resolved';
		},
		(error: unknown) => {
			outcome = error instanceof Error ? error.name : String(error);
		},
	);
	return new Promise<string>((resolve) =>
		setTimeout(() => resolve(outcome), ms),
	);
}

describe('a repository on the database a transaction holds', () => {
	test('is refused by name instead of waiting forever', async () => {
		const repository = createRepository(t.db, teams);
		const error = await withTransaction(t.db, async () => {
			return await repository.create({ name: 'Core' }).then(
				() => undefined,
				(caught: unknown) => caught,
			);
		});

		expect(error).toBeInstanceOf(TypeError);
		// A bare one. `ArgumentError` is for a value that could have come from
		// a request, and a repository bound to the wrong database cannot: it
		// is wiring, so no handler should be answering it 400.
		expect(error).not.toBeInstanceOf(ArgumentError);
		expect((error as Error).name).toBe('TypeError');
		expect((error as Error).message).toBe(
			'The repository for "teams" is bound to the database withTransaction ' +
				'is holding open, so this call would wait for a connection that ' +
				'transaction will not release until it ends, and never return. ' +
				'Call .with(tx) to run it in the transaction, or .with(db) to say ' +
				'you mean the database itself.',
		);
	});

	test('is refused whichever method reaches the database', async () => {
		const repository = createRepository(t.db, teams);
		// `paginate` runs no query itself: it counts and lists through two
		// other methods. The refusal sits where they meet the database, so it
		// covers them and every call built on them.
		const names = await withTransaction(t.db, async () =>
			Promise.all(
				(
					[
						() => repository.paginate({ page: 1 }),
						() => repository.findMany(),
						() => repository.exists({ name: 'Core' }),
						() => repository.count(),
						() => repository.updateMany({ name: 'Core' }, { name: 'a' }),
					] as const
				).map((call) =>
					call().then(
						() => 'resolved',
						(error: unknown) =>
							error instanceof Error ? error.name : String(error),
					),
				),
			),
		);
		expect(names).toEqual(Array(5).fill('TypeError'));
	});

	test('is not refused when it was re-bound to the transaction', async () => {
		const repository = createRepository(t.db, teams);
		const team = await withTransaction(t.db, (tx) =>
			repository.with(tx).create({ name: 'Core' }),
		);
		expect(team.name).toBe('Core');
		expect(await t.db.select().from(teams)).toHaveLength(1);
	});

	test('is not refused when it was built on the transaction', async () => {
		const team = await withTransaction(t.db, (tx) =>
			createRepository(tx, teams).create({ name: 'Core' }),
		);
		expect(team.name).toBe('Core');
	});

	test('is not refused outside a transaction', async () => {
		const repository = createRepository(t.db, teams);
		expect((await repository.create({ name: 'Core' })).name).toBe('Core');
	});

	test('is not refused in a savepoint of the transaction it is bound to', async () => {
		// The nested call opens a savepoint on the connection the outer
		// transaction already holds, so a repository bound to that outer
		// transaction is not the mistake this refusal is about. Only the
		// outermost `withTransaction` records what it holds, which is what
		// keeps this from being refused.
		const name = await withTransaction(t.db, async (tx) => {
			const bound = createRepository(t.db, teams).with(tx);
			return await withTransaction(tx, async () => {
				return (await bound.create({ name: 'Core' })).name;
			});
		});
		expect(name).toBe('Core');
	});

	test('a repository on another database is left alone', async () => {
		// The refusal compares against the database this transaction holds,
		// not "is some transaction open", so work on an unrelated database
		// goes through untouched.
		const other = await createTestDb();
		try {
			const elsewhere = createRepository(other.db, teams);
			const name = await withTransaction(t.db, async () => {
				return (await elsewhere.create({ name: 'Elsewhere' })).name;
			});
			expect(name).toBe('Elsewhere');
		} finally {
			await other.close();
		}
	});

	test('stops at the commit: a call made after it is not refused', async () => {
		// An async context outlives the call that made it, so a promise created
		// inside the callback still reads the store afterwards. The record is
		// closed when the callback settles, because by then the connection is
		// back in the pool and this call would have worked.
		const repository = createRepository(t.db, teams);
		let afterwards!: Promise<unknown>;
		await withTransaction(t.db, async (tx) => {
			await repository.with(tx).create({ name: 'Core' });
			afterwards = sleep(5).then(() => repository.findMany());
		});
		expect(await afterwards).toHaveLength(1);
	});

	test('stops at the commit: a fire-and-forget call does not end the process', async () => {
		// The same leak, in the shape that cannot be caught: nobody is waiting
		// on this one, so a refusal here is an unhandled rejection, which ends
		// the process in Bun — on code that worked before the refusal existed.
		// Reaching the assertion at all is the test.
		const repository = createRepository(t.db, teams);
		let outcome = 'never ran';
		await withTransaction(t.db, async () => {
			setTimeout(() => {
				void repository.findMany().then(
					() => {
						outcome = 'resolved';
					},
					(error: unknown) => {
						outcome = error instanceof Error ? error.name : String(error);
					},
				);
			}, 5);
		});
		await sleep(40);
		expect(outcome).toBe('resolved');
	});

	test('reaches the caller as it was thrown, not as a DataError', async () => {
		// `withTransaction` puts every failure through `toDataError` on the way
		// out. This one must come through untouched: it is the shape the README
		// and the guides show reaching an application's error handler, and a
		// `DataError` there would be answered by the wrong branch.
		const repository = createRepository(t.db, teams);
		const error = await withTransaction(t.db, () =>
			repository.create({ name: 'Core' }),
		).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(TypeError);
		expect(error).not.toBeInstanceOf(DataError);
		expect(await t.db.select().from(teams)).toHaveLength(0);
	});

	test('.with(db) says the caller means the database, and is not refused', async () => {
		// Left waiting on purpose and never awaited: `.with(db)` asks the pool
		// for a second connection, and PGlite's pool is one connection that
		// the open transaction is holding — so on this driver it deadlocks,
		// exactly as it did before the refusal existed. That is the driver,
		// not this package: on a pooled driver the call takes another
		// connection and its work survives a rollback. What is asserted here
		// is only that nothing refused it.
		const outcome = await withTransaction(t.db, async () => {
			const deliberate = createRepository(t.db, users)
				.with(t.db)
				.create({ email: 'ada@example.com' });
			return await within(deliberate, 150);
		});
		expect(outcome).toBe('waiting');
	});
});
