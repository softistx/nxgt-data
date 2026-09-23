import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { rejection, rejectionMessage } from '../../test/rejection';
import { users } from '../../test/schema';
import { startMongo, type TestServer } from '../../test/server';
import { getCollection } from '../collection/get-collection';
import { ConflictError } from '../errors/data-error';
import { withTransaction } from './with-transaction';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo();
}, 120_000);
beforeEach(async () => {
	await t.reset();
	await getCollection(t.db, users).sync();
});
afterAll(() => t.stop());

const collection = () => getCollection(t.db, users);
const emails = async () =>
	(await collection().findMany({ sort: { email: 1 } })).map(
		(user) => user.email,
	);

describe('withTransaction', () => {
	test('commits when fn resolves, and returns its value', async () => {
		const created = await withTransaction(t.client, async (session) => {
			return collection()
				.withSession(session)
				.create({ email: 'ada@example.com' });
		});
		expect(created.email).toBe('ada@example.com');
		expect(await emails()).toEqual(['ada@example.com']);
	});

	test('aborts when fn throws, and rethrows', async () => {
		const stop = new Error('stop');
		expect(
			await rejection(
				withTransaction(t.client, async (session) => {
					await collection()
						.withSession(session)
						.create({ email: 'ada@example.com' });
					throw stop;
				}),
			),
		).toBe(stop);
		expect(await emails()).toEqual([]);
	});

	test('turns a MongoDB error into a DataError, and aborts', async () => {
		await collection().create({ email: 'ada@example.com' });
		expect(
			await rejection(
				withTransaction(t.client, async (session) => {
					const scoped = collection().withSession(session);
					await scoped.create({ email: 'bob@example.com' });
					await scoped.create({ email: 'ada@example.com' });
				}),
			),
		).toBeInstanceOf(ConflictError);
		expect(await emails()).toEqual(['ada@example.com']);
	});

	test('a write that was not given the session is not in the transaction', async () => {
		// MongoDB has no ambient session: this is the trap the API exists for.
		await withTransaction(t.client, async (session) => {
			await collection()
				.withSession(session)
				.create({ email: 'inside@example.com' });
			await collection().create({ email: 'outside@example.com' });
			throw new Error('abort');
		}).catch(() => {});
		expect(await emails()).toEqual(['outside@example.com']);
	});

	test('aborting inside fn resolves rather than throwing', async () => {
		const result = await withTransaction(t.client, async (session) => {
			await collection()
				.withSession(session)
				.create({ email: 'ada@example.com' });
			await session.abortTransaction();
			return 'aborted';
		});
		expect(result).toBe('aborted');
		expect(await emails()).toEqual([]);
	});

	test('a session already in a transaction is joined, not started again', async () => {
		await withTransaction(t.client, async (session) => {
			await collection()
				.withSession(session)
				.create({ email: 'outer@example.com' });
			// Starting a second transaction on one session is a MongoDB error;
			// this joins the one that is open.
			const inner = await withTransaction(session, async (same) => {
				expect(same).toBe(session);
				await collection()
					.withSession(same)
					.create({ email: 'inner@example.com' });
				return 'joined';
			});
			expect(inner).toBe('joined');
		});
		expect(await emails()).toEqual(['inner@example.com', 'outer@example.com']);
	});

	test('the join is not a savepoint: an inner failure takes the outer down', async () => {
		await withTransaction(t.client, async (session) => {
			await collection()
				.withSession(session)
				.create({ email: 'outer@example.com' });
			await withTransaction(session, async (same) => {
				await collection()
					.withSession(same)
					.create({ email: 'inner@example.com' });
				throw new Error('inner fails');
			});
		}).catch(() => {});
		expect(await emails()).toEqual([]);
	});

	test('a joined transaction refuses options of its own', async () => {
		await withTransaction(t.client, async (session) => {
			expect(
				await rejectionMessage(
					withTransaction(session, async () => {}, {
						readConcern: { level: 'snapshot' },
					}),
				),
			).toContain('already in a transaction');
		});
	});

	test('a session that is not in a transaction starts one', async () => {
		const session = t.client.startSession();
		try {
			await withTransaction(session, async (same) => {
				await collection()
					.withSession(same)
					.create({ email: 'ada@example.com' });
			});
		} finally {
			await session.endSession();
		}
		expect(await emails()).toEqual(['ada@example.com']);
	});
});
