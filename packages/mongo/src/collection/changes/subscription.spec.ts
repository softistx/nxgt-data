import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { MongoClient } from 'mongodb';
import { rejection } from '../../../test/rejection';
import { posts } from '../../../test/schema';
import { startMongo, type TestServer } from '../../../test/server';
import { sleep, until } from '../../../test/until';
import { DataError } from '../../errors/data-error';
import { getCollection } from '../get-collection';
import type { ChangeSubscription } from './types';

let t: TestServer;
const open: ChangeSubscription[] = [];

beforeAll(async () => {
	t = await startMongo('nxgt-subscription');
}, 120_000);
beforeEach(async () => {
	await t.reset();
	await getCollection(t.db, posts).sync();
});
afterEach(async () => {
	await t.clearFailures();
	await Promise.all(open.splice(0).map((s) => s.close()));
});
afterAll(async () => {
	await t.stop();
});

/**
 * Closes this subscription after the test, and takes the rejection `closed`
 * would end with if it ever failed: nobody is waiting for it in a test that
 * expects it to resolve, and Bun counts an unhandled rejection as an error —
 * so a regression would print a raw `error:` line instead of failing the
 * assertion that came to catch it.
 */
function track<S extends ChangeSubscription>(subscription: S): S {
	open.push(subscription);
	subscription.closed.catch(() => undefined);
	return subscription;
}

/**
 * 43 CursorNotFound. The driver resumes once on its own after a failed
 * `getMore`, so a spec fails the `aggregate` of that resume too: then it gives
 * up, and this package reopens. Not 91, which also makes the driver forget the
 * server and wait ten seconds to find it again — measured.
 */
const TRANSIENT = { errorCode: 43 };

describe('the handler', () => {
	test('gets one change at a time, in order', async () => {
		const collection = getCollection(t.db, posts);
		const events: string[] = [];
		const subscription = track(
			collection.onChange(async (c) => {
				events.push(`start ${c.document?.title}`);
				await sleep(50);
				events.push(`end ${c.document?.title}`);
			}),
		);
		await subscription.ready;
		await collection.create({ title: 'a', rank: 1 });
		await collection.create({ title: 'b', rank: 2 });
		await until(() => events.length === 4, 'both handled');
		expect(events).toEqual(['start a', 'end a', 'start b', 'end b']);
	});

	test('a failure goes to onError, and the stream goes on', async () => {
		const collection = getCollection(t.db, posts);
		const errors: unknown[] = [];
		const heard: string[] = [];
		const subscription = track(
			collection.onChange(
				(c) => {
					if (c.document?.title === 'bad') throw new Error('nope');
					heard.push(c.document?.title ?? '');
				},
				{
					onError: (error, change) =>
						void errors.push([(error as Error).message, change?.type]),
				},
			),
		);
		await subscription.ready;
		await collection.create({ title: 'bad', rank: 1 });
		await collection.create({ title: 'good', rank: 2 });
		await until(() => heard.length === 1, 'the good one');
		expect(errors).toEqual([['nope', 'create']]);
	});

	test('an onError that throws stops it, and is not called again', async () => {
		const collection = getCollection(t.db, posts);
		let calls = 0;
		const subscription = collection.onChange(
			() => {
				throw new Error('first');
			},
			{
				onError: () => {
					calls += 1;
					throw new Error('second');
				},
			},
		);
		const closed = rejection(subscription.closed);
		await subscription.ready;
		await collection.create({ title: 'a', rank: 1 });
		expect(await closed).toHaveProperty('message', 'second');
		expect(calls).toBe(1);
	});

	test('without onError, a failure stops the subscription', async () => {
		const collection = getCollection(t.db, posts);
		const subscription = collection.onChange(() => {
			throw new Error('nope');
		});
		const closed = rejection(subscription.closed);
		await subscription.ready;
		await collection.create({ title: 'a', rank: 1 });
		expect(await closed).toHaveProperty('message', 'nope');
	});

	test('can close its own subscription', async () => {
		const collection = getCollection(t.db, posts);
		let subscription: ChangeSubscription | undefined;
		let returned = false;
		subscription = collection.onChange(async () => {
			await subscription?.close();
			returned = true;
		});
		await subscription.ready;
		await collection.create({ title: 'a', rank: 1 });
		expect(await subscription.closed).toBe('closed');
		expect(returned).toBe(true);
	});

	test('an error thrown while closing is not lost', async () => {
		const collection = getCollection(t.db, posts);
		let entered = false;
		const subscription = collection.onChange(async () => {
			entered = true;
			await sleep(100);
			throw new Error('late');
		});
		const closed = rejection(subscription.closed);
		await subscription.ready;
		await collection.create({ title: 'a', rank: 1 });
		await until(() => entered, 'the handler');
		await subscription.close();
		expect(await closed).toHaveProperty('message', 'late');
	});
});

describe('when the stream fails', () => {
	test('it reopens from its token, and misses nothing', async () => {
		const collection = getCollection(t.db, posts);
		const heard: string[] = [];
		const subscription = track(
			collection.onChange((c) => void heard.push(c.document?.title ?? '')),
		);
		await subscription.ready;
		// The read after `a` fails, and so does the driver's resume, then two
		// attempts to reopen: pauses of 100, 200 and 400 ms — measured, 700 ms
		// down. `b` and `c` are written
		// in them, so a stream reopened from now would miss both.
		await t.failNext(['getMore', 'aggregate'], TRANSIENT, 4);
		await collection.create({ title: 'a', rank: 1 });
		await until(() => heard.includes('a'), 'a');
		await collection.create({ title: 'b', rank: 2 });
		await collection.create({ title: 'c', rank: 3 });
		await until(() => heard.length === 3, 'all three');
		expect(heard).toEqual(['a', 'b', 'c']);
	});

	test('it gives up after its retries, with a DataError', async () => {
		const collection = getCollection(t.db, posts);
		await t.failNext(['getMore', 'aggregate'], TRANSIENT, 10);
		const subscription = collection.onChange(() => {}, { retries: 1 });
		const failure = await subscription.closed.catch((error) => error);
		expect(failure).toBeInstanceOf(DataError);
		expect(failure).toMatchObject({ serverCode: 43, collection: 'posts' });
		// It never opened, so `ready` says so too. `ready` needs no holding of
		// its own: the package takes its rejection when it makes it.
		await expect(subscription.ready).rejects.toBe(failure);
	});

	test('a read that works ends a run of failures', async () => {
		const collection = getCollection(t.db, posts);
		const heard: string[] = [];
		const subscription = track(
			collection.onChange((c) => void heard.push(c.document?.title ?? ''), {
				retries: 1,
			}),
		);
		await subscription.ready;
		for (const title of ['a', 'b']) {
			// One failed attempt each round, on the read after `title`; the next
			// change is only heard once the stream is back. With a count that
			// never went back to zero, the second would be one too many.
			await t.failNext(['getMore', 'aggregate'], TRANSIENT, 2);
			await collection.create({ title, rank: 1 });
			await until(() => heard.includes(title), title);
			await collection.create({ title: `${title}2`, rank: 2 });
			await until(() => heard.includes(`${title}2`), `${title}2`);
		}
		expect(heard).toEqual(['a', 'a2', 'b', 'b2']);
		expect(await Promise.race([subscription.closed, 'open'])).toBe('open');
	});

	test('a fatal error is not retried, and onError hears it', async () => {
		const collection = getCollection(t.db, posts);
		const errors: unknown[] = [];
		const subscription = collection.onChange(() => {}, {
			onError: (error, change) =>
				void errors.push([(error as DataError).serverCode, change]),
		});
		await subscription.ready;
		await t.failNext(['getMore'], { errorCode: 280 });
		expect(await subscription.closed).toBe('failed');
		expect(errors).toEqual([[280, undefined]]);
	});

	test('onError can close the subscription a fatal error ended', async () => {
		const collection = getCollection(t.db, posts);
		let subscription: ChangeSubscription | undefined;
		let returned = false;
		subscription = collection.onChange(() => {}, {
			onError: async () => {
				await subscription?.close();
				returned = true;
			},
		});
		await subscription.ready;
		await t.failNext(['getMore'], { errorCode: 280 });
		expect(await subscription.closed).toBe('failed');
		expect(returned).toBe(true);
	});

	test('a closed client is not retried', async () => {
		const client = new MongoClient(t.uri);
		await client.connect();
		const collection = getCollection(client, posts);
		const subscription = collection.onChange(() => {});
		const closed = rejection(subscription.closed);
		await subscription.ready;
		const started = Date.now();
		await client.close();
		expect(await closed).toBeInstanceOf(Error);
		// Five retries would pause 3.1 seconds in all.
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	test('a token the server refuses fails at once', async () => {
		const collection = getCollection(t.db, posts);
		for (const token of [{ _data: 'nonsense' }, 'abc', { foo: 1 }]) {
			const started = Date.now();
			const subscription = collection.onChange(() => {}, {
				startAfter: token as never,
			});
			await expect(subscription.closed).rejects.toBeInstanceOf(DataError);
			// Five retries would pause 3.1 seconds in all.
			expect(Date.now() - started).toBeLessThan(1_000);
		}
	});

	test('close() does not wait out the pause between two attempts', async () => {
		const collection = getCollection(t.db, posts);
		// Every attempt fails at once, then pauses 100, 200, 400, 800 and
		// 1,600 ms: at two seconds, it is in that last pause.
		await t.failNext(['getMore', 'aggregate'], TRANSIENT, 50);
		const subscription = collection.onChange(() => {}, { retries: 10 });
		await sleep(2_000);
		const started = Date.now();
		await subscription.close();
		expect(Date.now() - started).toBeLessThan(400);
		expect(await subscription.closed).toBe('closed');
	});

	test('a dropped collection ends it', async () => {
		const collection = getCollection(t.db, posts);
		const subscription = collection.onChange(() => {});
		await subscription.ready;
		await collection.raw.drop();
		expect(await subscription.closed).toBe('invalidated');
	});
});

describe('closing', () => {
	test('resolves closed, and can be done with await using', async () => {
		const collection = getCollection(t.db, posts);
		let closed: Promise<unknown> | undefined;
		{
			await using subscription = collection.onChange(() => {});
			await subscription.ready;
			closed = subscription.closed;
		}
		expect(await closed).toBe('closed');
	});

	test('waits for the change being handled', async () => {
		const collection = getCollection(t.db, posts);
		let finished = false;
		let started = false;
		const subscription = collection.onChange(async () => {
			started = true;
			await sleep(100);
			finished = true;
		});
		await subscription.ready;
		await collection.create({ title: 'a', rank: 1 });
		await until(() => started, 'the handler');
		await subscription.close();
		expect(finished).toBe(true);
	});

	test('retries must be a whole number', () => {
		const collection = getCollection(t.db, posts);
		for (const retries of [-1, 1.5, Number.NaN]) {
			expect(() => collection.onChange(() => {}, { retries })).toThrow(
				'retries must be a whole number',
			);
		}
	});
});
