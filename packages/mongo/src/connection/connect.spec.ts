import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from 'bun:test';
import { startMongo, type TestServer } from '../../test/server';
import { ConnectionError } from '../errors/data-error';
import { closeMongo, connectMongo } from './connect';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo('nxgt-connect');
}, 120_000);
afterEach(async () => {
	await closeMongo();
});
afterAll(async () => {
	await t.stop();
});

/** Nothing listens there: a connect fails fast, with a short selection timeout. */
const NOWHERE = 'mongodb://127.0.0.1:9/nowhere?serverSelectionTimeoutMS=200';

describe('connectMongo', () => {
	test('shares one client per URI, and uses its database', async () => {
		const [a, b] = await Promise.all([
			connectMongo(t.uri),
			connectMongo(t.uri),
		]);
		expect(a.client).toBe(b.client);
		expect(a.db.databaseName).toBe('nxgt-connect');
		await a.db.collection('x').insertOne({ n: 1 });
		expect(await b.db.collection('x').countDocuments()).toBe(1);
	});

	test('closes the client with its last connection', async () => {
		const a = await connectMongo(t.uri);
		const b = await connectMongo(t.uri);
		await a.close();
		await a.close();
		// b still holds it: a second close of a counts once.
		expect((await b.ping()).ok).toBe(true);
		await b.close();
		expect((await b.ping()).ok).toBe(false);
		const c = await connectMongo(t.uri);
		expect(c.client).not.toBe(a.client);
		expect((await c.ping()).ok).toBe(true);
	});

	test('can be disposed with await using', async () => {
		let client: unknown;
		{
			await using mongo = await connectMongo(t.uri);
			client = mongo.client;
		}
		const again = await connectMongo(t.uri);
		expect(again.client).not.toBe(client);
	});

	test('refuses other options for a connected URI, without naming it', async () => {
		await connectMongo(t.uri, { appName: 'one' });
		await connectMongo(t.uri, { appName: 'one' });
		const error = await connectMongo(t.uri, { appName: 'two' }).catch(
			(e: unknown) => e as Error,
		);
		expect(error).toBeInstanceOf(TypeError);
		expect((error as Error).message).toContain('other options');
		expect((error as Error).message).not.toContain(t.uri);
	});

	test('compares options by value, as they were given', async () => {
		const options = { appName: 'one', serverApi: { version: '1' as const } };
		const a = await connectMongo(t.uri, options);
		// Built again: the same values, another object.
		const b = await connectMongo(t.uri, {
			appName: 'one',
			serverApi: { version: '1' },
		});
		expect(b.client).toBe(a.client);
		// Changing the first object afterwards changes nothing.
		options.appName = 'two';
		await expect(connectMongo(t.uri, options)).rejects.toThrow('other options');
		// A key only the second call has is a difference too.
		await expect(
			connectMongo(t.uri, { ...options, appName: 'one', retryWrites: false }),
		).rejects.toThrow('other options');
	});

	test('forgets a failed connect, so the next call tries again', async () => {
		const [first, second] = await Promise.allSettled([
			connectMongo(NOWHERE),
			connectMongo(NOWHERE),
		]);
		expect(first.status).toBe('rejected');
		expect(second.status).toBe('rejected');
		// Rejected with the same error: one attempt, shared.
		expect((first as PromiseRejectedResult).reason).toBe(
			(second as PromiseRejectedResult).reason,
		);
		const third = await connectMongo(NOWHERE).catch((e: unknown) => e);
		expect(third).not.toBe((first as PromiseRejectedResult).reason);
	});
});

describe('ping', () => {
	test('answers with the latency', async () => {
		const mongo = await connectMongo(t.uri);
		const result = await mongo.ping();
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.latencyMs).toBeGreaterThanOrEqual(0);
	});

	test('answers within its timeout when the server does not', async () => {
		const mongo = await connectMongo(t.uri);
		await t.failNext(['ping'], { blockConnection: true, blockTimeMS: 4_000 });
		const started = Date.now();
		// The default: two seconds.
		const result = await mongo.ping();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect((result.error as Error).name).toBe('MongoOperationTimeoutError');
		}
		expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
		expect(Date.now() - started).toBeLessThan(3_500);
		await t.clearFailures();
	});
});

describe('closeMongo', () => {
	test('closes every client, and later closes do nothing', async () => {
		const a = await connectMongo(t.uri);
		await closeMongo();
		expect((await a.ping()).ok).toBe(false);
		const b = await connectMongo(t.uri);
		// `a` held the client `closeMongo` closed, not `b`'s.
		await a.close();
		expect((await b.ping()).ok).toBe(true);
		const c = await connectMongo(t.uri);
		expect(c.client).toBe(b.client);
	});

	test('a connect it interrupts fails rather than hand a closed client', async () => {
		// Held from here: `closeMongo` is what rejects it, so between the two
		// lines below the rejection would have nobody waiting on it.
		const pending = connectMongo(t.uri).then(
			() => {
				throw new Error('it connected, and should not have');
			},
			(error: unknown) => error,
		);
		await closeMongo();
		const error = await pending;
		expect(error).toHaveProperty(
			'message',
			expect.stringContaining('closed while this one'),
		);
		expect(error).toBeInstanceOf(ConnectionError);
		expect(error).toHaveProperty('code', 'CONNECTION');
		// Never the URI: a connection string holds the password. The mirror of
		// this assertion is in `@nxgt/redis`'s `connect.spec.ts`.
		expect((error as Error).message).not.toContain(t.uri);
		const after = await connectMongo(t.uri);
		expect((await after.ping()).ok).toBe(true);
	});

	test('two closes at once both wait for the client', async () => {
		const mongo = await connectMongo(t.uri);
		const first = mongo.close();
		await mongo.close();
		expect((await mongo.ping()).ok).toBe(false);
		await first;
	});
});
