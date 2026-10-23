import {
	afterAll,
	afterEach,
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
import { ConflictError, DataError } from '../errors/data-error';
import {
	commitRetryingUnknownResult,
	withTransaction,
} from './with-transaction';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo();
}, 120_000);
beforeEach(async () => {
	await t.reset();
	await getCollection(t.db, users).sync();
});
afterEach(() => t.clearFailures());
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

	describe('a transient error inside the transaction', () => {
		// The server fails the first insert as a write conflict, which it labels
		// as one the whole transaction is safe to retry after.
		const failOnce = () =>
			t.failNext(['insert'], {
				errorCode: 112,
				errorLabels: ['TransientTransactionError'],
			});

		test('is retried by the driver, though the collection threw a DataError', async () => {
			await failOnce();
			let runs = 0;
			await withTransaction(t.client, async (session) => {
				runs += 1;
				await collection()
					.withSession(session)
					.create({ email: 'ada@example.com' });
			});
			expect(runs).toBe(2);
			expect(await emails()).toEqual(['ada@example.com']);
		});

		test('is retried through a joined transaction too', async () => {
			await failOnce();
			let runs = 0;
			await withTransaction(t.client, (outer) =>
				withTransaction(outer, async (session) => {
					runs += 1;
					await collection()
						.withSession(session)
						.create({ email: 'ada@example.com' });
				}),
			);
			expect(runs).toBe(2);
			expect(await emails()).toEqual(['ada@example.com']);
		});
	});

	describe('retryTransient: false', () => {
		const transient = {
			errorCode: 112,
			errorLabels: ['TransientTransactionError'],
		};
		const hasLabel = (error: unknown) =>
			error instanceof DataError &&
			error.hasErrorLabel('TransientTransactionError');

		test('commits on success', async () => {
			const created = await withTransaction(
				t.client,
				(session) =>
					collection()
						.withSession(session)
						.create({ email: 'ada@example.com' }),
				{ retryTransient: false },
			);
			expect(created.email).toBe('ada@example.com');
			expect(await emails()).toEqual(['ada@example.com']);
		});

		test('still passes the driver options on', async () => {
			await withTransaction(
				t.client,
				async (session) => {
					expect(
						(
							session as unknown as {
								transaction: { options: { readConcern?: { level?: string } } };
							}
						).transaction.options.readConcern?.level,
					).toBe('snapshot');
					await collection()
						.withSession(session)
						.create({ email: 'ada@example.com' });
				},
				{ retryTransient: false, readConcern: { level: 'snapshot' } },
			);
			expect(await emails()).toEqual(['ada@example.com']);
		});

		test('a session not in a transaction takes the same path', async () => {
			const session = t.client.startSession();
			let runs = 0;
			try {
				await t.failNext(['insert'], transient);
				const error = await rejection(
					withTransaction(
						session,
						async (same) => {
							runs += 1;
							await collection()
								.withSession(same)
								.create({ email: 'ada@example.com' });
						},
						{ retryTransient: false },
					),
				);
				expect(hasLabel(error)).toBe(true);
			} finally {
				await session.endSession();
			}
			expect(runs).toBe(1);
			expect(await emails()).toEqual([]);
		});

		test('runs fn once on a transient error, handed back as a DataError', async () => {
			await t.failNext(['insert'], transient);
			let runs = 0;
			const error = await rejection(
				withTransaction(
					t.client,
					async (session) => {
						runs += 1;
						await collection()
							.withSession(session)
							.create({ email: 'ada@example.com' });
					},
					{ retryTransient: false },
				),
			);
			expect(runs).toBe(1);
			expect(hasLabel(error)).toBe(true);
			expect(await emails()).toEqual([]);
		});

		test('runs fn once when the commit fails transiently', async () => {
			await t.failNext(['commitTransaction'], transient);
			let runs = 0;
			try {
				const error = await rejection(
					withTransaction(
						t.client,
						async (session) => {
							runs += 1;
							await collection()
								.withSession(session)
								.create({ email: 'ada@example.com' });
						},
						{ retryTransient: false },
					),
				);
				expect(runs).toBe(1);
				expect(error).toBeInstanceOf(DataError);
			} finally {
				// The driver did not retry the commit (a transient label is not a
				// retryable write error), and the injected failure never reached the
				// server, which still holds the transaction open. The driver cannot
				// abort after a commit attempt, so end it here or the next
				// `dropDatabase` waits for it.
				await t.client.db('admin').command({ killAllSessions: [] });
			}
			expect(await emails()).toEqual([]);
		});

		describe('an unknown commit result', () => {
			// A retryable write error the server labels as an unknown commit
			// result. The driver's `commitTransaction` retries it once by itself,
			// so two failures are what reach the caller.
			const unknown = {
				errorCode: 262,
				errorLabels: ['UnknownTransactionCommitResult'],
			};

			test('retries the commit alone, fn runs once and the work lands once', async () => {
				try {
					await t.failNext(['commitTransaction'], unknown, 2);
					let runs = 0;
					await withTransaction(
						t.client,
						async (session) => {
							runs += 1;
							await collection()
								.withSession(session)
								.create({ email: 'ada@example.com' });
						},
						{ retryTransient: false },
					);
					expect(runs).toBe(1);
					expect(await emails()).toEqual(['ada@example.com']);
				} finally {
					await t.clearFailures();
					await t.client.db('admin').command({ killAllSessions: [] });
				}
			});

			test('stops retrying once its deadline has passed', async () => {
				const session = t.client.startSession();
				try {
					await t.failNext(['commitTransaction'], unknown, 2);
					session.startTransaction();
					await collection()
						.withSession(session)
						.create({ email: 'ada@example.com' });
					const error = await rejection(
						commitRetryingUnknownResult(session, performance.now() - 1),
					);
					expect(error).toBeDefined();
					expect(
						(error as { hasErrorLabel(label: string): boolean }).hasErrorLabel(
							'UnknownTransactionCommitResult',
						),
					).toBe(true);
				} finally {
					await t.clearFailures();
					await t.client.db('admin').command({ killAllSessions: [] });
					await session.endSession().catch(() => {});
				}
			});

			test('is not retried when it is MaxTimeMSExpired', async () => {
				// Guards the retry loop against retrying MaxTimeMSExpired (the old code also refused it).
				try {
					// Three failures: if the commit were retried, the spec would see
					// it succeed or the failpoint run out.
					await t.failNext(
						['commitTransaction'],
						{ errorCode: 50, errorLabels: ['UnknownTransactionCommitResult'] },
						3,
					);
					let runs = 0;
					const error = await rejection(
						withTransaction(
							t.client,
							async (session) => {
								runs += 1;
								await collection()
									.withSession(session)
									.create({ email: 'ada@example.com' });
							},
							{ retryTransient: false },
						),
					);
					expect(runs).toBe(1);
					expect(error).toBeInstanceOf(DataError);
				} finally {
					await t.clearFailures();
					await t.client.db('admin').command({ killAllSessions: [] });
				}
				expect(await emails()).toEqual([]);
			});
		});

		test('does not rerun fn on a raw driver error', async () => {
			await t.failNext(['insert'], transient);
			let runs = 0;
			const error = await rejection(
				withTransaction(
					t.client,
					async (session) => {
						runs += 1;
						await collection().raw.insertOne(
							{ email: 'ada@example.com' } as never,
							{ session },
						);
					},
					{ retryTransient: false },
				),
			);
			expect(runs).toBe(1);
			expect(error).toBeInstanceOf(DataError);
			expect(await emails()).toEqual([]);
		});

		test('a joined transaction refuses it', async () => {
			await withTransaction(t.client, async (session) => {
				expect(
					await rejectionMessage(
						withTransaction(session, async () => {}, {
							retryTransient: false,
						}),
					),
				).toContain('retryTransient');
			});
		});
	});

	describe('an error the driver does not retry', () => {
		test('a DataError without a retry label runs the callback once', async () => {
			await t.failNext(['insert'], { errorCode: 11000 });
			let runs = 0;
			const error = await rejection(
				withTransaction(t.client, async (session) => {
					runs += 1;
					await collection()
						.withSession(session)
						.create({ email: 'ada@example.com' });
				}),
			);
			expect(runs).toBe(1);
			expect(error).toBeInstanceOf(DataError);
			expect(await emails()).toEqual([]);
		});

		test('a DataError whose cause carries no hasErrorLabel passes through unchanged', async () => {
			const thrown = new DataError('boom', { cause: new Error('plain') });
			let runs = 0;
			const error = await rejection(
				withTransaction(t.client, async () => {
					runs += 1;
					throw thrown;
				}),
			);
			expect(runs).toBe(1);
			expect(error).toBe(thrown);
		});
	});
});
