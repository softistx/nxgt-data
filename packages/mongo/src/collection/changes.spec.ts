import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { z } from 'zod';
import { logs, posts, users } from '../../test/schema';
import { startMongo, type TestServer } from '../../test/server';
import { defineCollection } from '../definition/define-collection';
import { id } from '../definition/fields';
import { DataError } from '../errors/data-error';
import type { ChangeSubscription } from './change-types';
import { getCollection } from './get-collection';

let t: TestServer;
const open: ChangeSubscription[] = [];

beforeAll(async () => {
	t = await startMongo('nxgt-changes');
}, 120_000);
beforeEach(async () => {
	await Promise.all(open.splice(0).map((s) => s.close()));
	await t.reset();
	await getCollection(t.db, users).sync();
	await getCollection(t.db, posts).sync();
});
afterAll(async () => {
	await Promise.all(open.splice(0).map((s) => s.close()));
	await t.stop();
});

/** Waits until `check` holds, or fails after a while. */
async function until(check: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function track<S extends ChangeSubscription>(subscription: S): S {
	open.push(subscription);
	return subscription;
}

describe('what a subscription hears', () => {
	test('creates, updates and hard deletes, typed and in order', async () => {
		const collection = getCollection(t.db, posts);
		const heard: unknown[] = [];
		const subscription = track(
			collection.onChange((change) => {
				heard.push([change.type, change.document?.title, change.id]);
			}),
		);
		await subscription.ready;

		const post = await collection.create({ title: 'a', rank: 1 });
		await collection.update(post._id, { title: 'b' });
		await collection.delete(post._id);
		await until(() => heard.length === 3, 'three changes');

		expect(heard).toEqual([
			['create', 'a', post._id],
			['update', 'b', post._id],
			['delete', undefined, post._id],
		]);
	});

	test('a document read from a change has its id, like any read', async () => {
		const collection = getCollection(t.db, posts);
		let seen: string | undefined;
		const subscription = track(
			collection.onChange((change) => {
				seen = change.document?.id;
			}),
		);
		await subscription.ready;
		const post = await collection.create({ title: 'a', rank: 1 });
		await until(() => seen !== undefined, 'the create');
		expect(seen).toBe(post.id);
	});

	test('an update says which fields it set and removed', async () => {
		// `logs` has no validator, so a field can be removed from it.
		const collection = getCollection(t.db, logs);
		const fields: unknown[] = [];
		const subscription = track(
			collection.onChange(
				(change) => {
					if (change.type === 'update') fields.push(change.fields);
				},
				{ events: ['update'] },
			),
		);
		await subscription.ready;
		const log = await collection.create({ message: 'a' });
		await collection.raw.updateOne(
			{ _id: log._id },
			{ $set: { message: 'b' }, $unset: { extra: '' } },
		);
		await collection.raw.updateOne(
			{ _id: log._id },
			{ $unset: { message: '' } },
		);
		await collection.raw.replaceOne({ _id: log._id }, { message: 'r' });
		await until(() => fields.length === 3, 'three updates');
		expect(fields).toEqual([
			{ set: { message: 'b' }, removed: [] },
			{ set: {}, removed: ['message'] },
			undefined,
		]);
	});
});

describe('soft deletes', () => {
	test('are deletes, and a restore is a restore', async () => {
		const collection = getCollection(t.db, users);
		const heard: unknown[] = [];
		const subscription = track(
			collection.onChange((change) => {
				heard.push([
					change.type,
					change.type === 'delete' ? change.hard : undefined,
				]);
			}),
		);
		await subscription.ready;
		const ada = await collection.create({ email: 'ada@example.com' });
		await collection.delete(ada._id);
		await collection.restore(ada._id);
		await collection.hardDelete(ada._id);
		await until(() => heard.length === 4, 'four changes');
		expect(heard).toEqual([
			['create', undefined],
			['delete', false],
			['restore', undefined],
			['delete', true],
		]);
	});

	test('an update to a soft-deleted document is heard only when asked', async () => {
		const collection = getCollection(t.db, users);
		const quiet: string[] = [];
		const loud: string[] = [];
		const subscriptions = [
			track(collection.onChange((c) => void quiet.push(c.type))),
			track(
				collection.onChange((c) => void loud.push(c.type), {
					withDeleted: true,
				}),
			),
		];
		await Promise.all(subscriptions.map((s) => s.ready));
		const ada = await collection.create({ email: 'ada@example.com' });
		await collection.delete(ada._id);
		await collection.raw.updateOne({ _id: ada._id }, { $set: { age: 3 } });
		await collection.create({ email: 'end@example.com' });
		await until(() => quiet.length === 3 && loud.length === 4, 'both');
		expect(quiet).toEqual(['create', 'delete', 'create']);
		expect(loud).toEqual(['create', 'delete', 'update', 'create']);
	});

	test('without the soft delete option, the stamp is an ordinary update', async () => {
		const collection = getCollection(t.db, users, { softDelete: false });
		const heard: string[] = [];
		const subscription = track(
			collection.onChange((c) => void heard.push(c.type)),
		);
		await subscription.ready;
		const ada = await collection.create({ email: 'ada@example.com' });
		await collection.raw.updateOne(
			{ _id: ada._id },
			{ $set: { deletedAt: new Date() } },
		);
		await until(() => heard.length === 2, 'two changes');
		expect(heard).toEqual(['create', 'update']);
	});
});

describe('choosing what to hear', () => {
	test('events narrows the types', async () => {
		const collection = getCollection(t.db, posts);
		const heard: string[] = [];
		const subscription = track(
			collection.onChange((c) => void heard.push(c.type), {
				events: ['delete'],
			}),
		);
		await subscription.ready;
		const post = await collection.create({ title: 'a', rank: 1 });
		await collection.update(post._id, { title: 'b' });
		await collection.delete(post._id);
		await until(() => heard.length === 1, 'the delete');
		expect(heard).toEqual(['delete']);
	});

	test('a filter is matched against the document', async () => {
		const collection = getCollection(t.db, posts);
		const heard: unknown[] = [];
		const subscription = track(
			collection.onChange((c) => void heard.push([c.type, c.document?.title]), {
				filter: { rank: { $gte: 2 } },
			}),
		);
		await subscription.ready;
		const low = await collection.create({ title: 'low', rank: 1 });
		await collection.create({ title: 'high', rank: 2 });
		// No pre-images here: a hard delete carries no document to match, so
		// it is delivered whatever the filter says.
		await collection.delete(low._id);
		await until(() => heard.length === 2, 'two changes');
		expect(heard).toEqual([
			['create', 'high'],
			['delete', undefined],
		]);
	});

	test('with pre-images, a delete is matched on the document it removed', async () => {
		const notes = defineCollection({
			name: 'notes',
			schema: z.object({ _id: id(), rank: z.number() }),
			options: { changeStreamPreAndPostImages: { enabled: true } },
		});
		const collection = getCollection(t.db, notes);
		await collection.sync();
		const heard: unknown[] = [];
		const subscription = track(
			collection.onChange(
				(c) =>
					void heard.push([
						c.type,
						c.type === 'create' ? undefined : c.before?.rank,
					]),
				{ filter: { rank: { $gte: 2 } } },
			),
		);
		await subscription.ready;
		const low = await collection.create({ rank: 1 });
		const high = await collection.create({ rank: 2 });
		await collection.delete(low._id);
		await collection.delete(high._id);
		await until(() => heard.length === 2, 'two changes');
		expect(heard).toEqual([
			['create', undefined],
			['delete', 2],
		]);
	});

	test('a filter combines conditions with $or', async () => {
		const collection = getCollection(t.db, posts);
		const heard: string[] = [];
		const subscription = track(
			collection.onChange((c) => void heard.push(c.document?.title ?? ''), {
				filter: { $or: [{ title: 'x' }, { rank: { $gt: 5 } }] },
				events: ['create'],
			}),
		);
		await subscription.ready;
		await collection.createMany([
			{ title: 'x', rank: 1 },
			{ title: 'y', rank: 1 },
			{ title: 'z', rank: 9 },
		]);
		await until(() => heard.length === 2, 'two creates');
		expect(heard).toEqual(['x', 'z']);
	});

	test('an operator that would read the event is refused at once', () => {
		const collection = getCollection(t.db, posts);
		expect(() =>
			collection.onChange(() => {}, {
				filter: { $expr: { $gt: ['$rank', 1] } },
			}),
		).toThrow('a filter cannot use $expr');
	});

	test('startAfter picks up where another subscription was', async () => {
		const collection = getCollection(t.db, posts);
		const first: string[] = [];
		const one = collection.onChange(
			(c) => void first.push(c.document?.title ?? ''),
		);
		await one.ready;
		await collection.create({ title: 'a', rank: 1 });
		await until(() => first.length === 1, 'the first create');
		const token = one.resumeToken;
		await one.close();

		// Made while nobody listened.
		await collection.create({ title: 'b', rank: 2 });
		const second: string[] = [];
		track(
			collection.onChange((c) => void second.push(c.document?.title ?? ''), {
				startAfter: token,
			}),
		);
		await until(() => second.length === 1, 'the missed create');
		expect(second).toEqual(['b']);
	});
});

describe('the handler', () => {
	test('gets one change at a time, in order', async () => {
		const collection = getCollection(t.db, posts);
		const log: string[] = [];
		let busy = false;
		const subscription = track(
			collection.onChange(async (c) => {
				if (busy) log.push('overlap');
				busy = true;
				await new Promise((resolve) => setTimeout(resolve, 30));
				log.push(c.document?.title ?? '');
				busy = false;
			}),
		);
		await subscription.ready;
		await collection.createMany([
			{ title: '1', rank: 1 },
			{ title: '2', rank: 2 },
			{ title: '3', rank: 3 },
		]);
		await until(() => log.length === 3, 'three changes');
		expect(log).toEqual(['1', '2', '3']);
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

	test('an onError that throws stops the subscription with its error', async () => {
		const collection = getCollection(t.db, posts);
		const subscription = collection.onChange(
			() => {
				throw new Error('first');
			},
			{
				onError: () => {
					throw new Error('second');
				},
			},
		);
		await subscription.ready;
		await collection.create({ title: 'a', rank: 1 });
		await expect(subscription.closed).rejects.toThrow('second');
	});

	test('without onError, a failure stops the subscription', async () => {
		const collection = getCollection(t.db, posts);
		const subscription = collection.onChange(() => {
			throw new Error('nope');
		});
		await subscription.ready;
		await collection.create({ title: 'a', rank: 1 });
		await expect(subscription.closed).rejects.toThrow('nope');
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
		// Not a resumable error: the driver gives up and closes its stream.
		// Measured, it gives up before handing over what was already there.
		await t.failNext(['getMore'], { errorCode: 2 });
		await collection.create({ title: 'a', rank: 1 });
		await collection.create({ title: 'b', rank: 2 });
		await until(() => heard.length === 2, 'both creates');
		expect(heard).toEqual(['a', 'b']);
	});

	test('it gives up after its retries, with a DataError', async () => {
		const collection = getCollection(t.db, posts);
		const subscription = collection.onChange(() => {}, { retries: 1 });
		await subscription.ready;
		await t.failNext(['getMore', 'aggregate'], { errorCode: 2 }, 10);
		const failure = await subscription.closed.catch((error) => error);
		await t.failNext(['getMore', 'aggregate'], { errorCode: 2 }, 0);
		expect(failure).toBeInstanceOf(DataError);
		expect(failure).toMatchObject({ serverCode: 2, collection: 'posts' });
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

	test('close() does not wait out the pause between two attempts', async () => {
		const collection = getCollection(t.db, posts);
		const subscription = collection.onChange(() => {}, { retries: 10 });
		await subscription.ready;
		await t.failNext(['getMore', 'aggregate'], { errorCode: 2 }, 50);
		// The `getMore` already out waits about a second on the server before
		// it meets the failpoint; then attempts fail at once, with pauses of
		// 100, 200, 400, then 800 ms — this lands in that last one.
		await new Promise((resolve) => setTimeout(resolve, 2_200));
		const started = Date.now();
		await subscription.close();
		await t.failNext(['getMore', 'aggregate'], { errorCode: 2 }, 0);
		expect(await subscription.closed).toBe('closed');
		expect(Date.now() - started).toBeLessThan(1_000);
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
			await new Promise((resolve) => setTimeout(resolve, 100));
			finished = true;
		});
		await subscription.ready;
		await collection.create({ title: 'a', rank: 1 });
		await until(() => started, 'the handler');
		await subscription.close();
		expect(finished).toBe(true);
	});
});
