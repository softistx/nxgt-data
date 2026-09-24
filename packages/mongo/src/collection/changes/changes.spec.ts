import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from 'bun:test';
import { z } from 'zod';
import { logs, posts, users } from '../../../test/schema';
import { startMongo, type TestServer } from '../../../test/server';
import { until } from '../../../test/until';
import { defineCollection } from '../../definition/define-collection';
import { id } from '../../definition/fields';
import { getCollection } from '../get-collection';
import type { ChangeSubscription } from './types';

// `until` gives a change 10 seconds to arrive, and Bun gives a test 5: on a
// loaded runner the test was killed before `until` could say what it was
// waiting for. A test here outlives every wait it makes.
setDefaultTimeout(30_000);

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
		// An update's document is looked up when it is read: delete before
		// then and it arrives with none. That is its own test, below.
		await until(() => heard.length === 2, 'the update');
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

	test('with pre-images, only a change of the stamp is a delete or a restore', async () => {
		const notes = defineCollection({
			name: 'notes',
			schema: z.object({ _id: id(), rank: z.number() }),
			softDelete: true,
			options: { changeStreamPreAndPostImages: { enabled: true } },
		});
		const collection = getCollection(t.db, notes);
		await collection.sync();
		const heard: string[] = [];
		const subscription = track(
			collection.onChange((c) => void heard.push(c.type), {
				withDeleted: true,
			}),
		);
		await subscription.ready;
		const note = await collection.create({ rank: 1 });
		const raw = collection.raw;
		await collection.delete(note._id);
		// Stamped again: still deleted, so an update.
		await raw.updateOne({ _id: note._id }, { $set: { deletedAt: new Date() } });
		const deleted = await raw.findOne({ _id: note._id });
		await raw.replaceOne({ _id: note._id }, {
			...deleted,
			deletedAt: null,
		} as never);
		// Cleared again, on a document that was not deleted: an update.
		await raw.updateOne(
			{ _id: note._id },
			{ $set: { deletedAt: null, rank: 2 } },
		);
		await until(() => heard.length === 5, 'five changes');
		expect(heard).toEqual(['create', 'delete', 'update', 'restore', 'update']);
	});

	test('without pre-images, the event alone decides', async () => {
		const collection = getCollection(t.db, users);
		const heard: string[] = [];
		const subscription = track(
			collection.onChange((c) => void heard.push(c.type), {
				withDeleted: true,
			}),
		);
		await subscription.ready;
		const ada = await collection.create({ email: 'ada@example.com' });
		const raw = collection.raw;
		await collection.delete(ada._id);
		// Stamped again: a delete, as nothing says it already was.
		await raw.updateOne({ _id: ada._id }, { $set: { deletedAt: new Date() } });
		const deleted = await raw.findOne({ _id: ada._id });
		await raw.replaceOne({ _id: ada._id }, { ...deleted, age: 4 } as never);
		// A replacement that clears the stamp cannot be told from any other.
		await raw.replaceOne({ _id: ada._id }, {
			...deleted,
			deletedAt: null,
		} as never);
		await until(() => heard.length === 5, 'five changes');
		expect(heard).toEqual(['create', 'delete', 'delete', 'delete', 'update']);
	});

	test('without pre-images, an update read after a delete has no document', async () => {
		const collection = getCollection(t.db, posts);
		const one = track(collection.onChange(() => {}));
		await one.ready;
		const post = await collection.create({ title: 'a', rank: 1 });
		await until(() => one.resumeToken !== undefined, 'the create');
		const token = one.resumeToken;
		await one.close();

		// Both made before anything reads the update, which is what a busy
		// server does to a subscription that is only a little behind.
		await collection.update(post._id, { title: 'b' });
		await collection.delete(post._id);
		const heard: unknown[] = [];
		track(
			collection.onChange((c) => void heard.push([c.type, c.document, c.id]), {
				startAfter: token,
			}),
		);
		await until(() => heard.length === 2, 'the update and the delete');
		expect(heard).toEqual([
			['update', undefined, post._id],
			['delete', undefined, post._id],
		]);
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
				// @ts-expect-error — refused in the types too
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

	test('position moves while the collection is quiet, resumeToken does not', async () => {
		const collection = getCollection(t.db, posts);
		const heard: string[] = [];
		const subscription = track(
			collection.onChange((c) => void heard.push(c.document?.title ?? '')),
		);
		await subscription.ready;
		expect(subscription.resumeToken).toBeUndefined();
		// The first read answered with nothing: the server said where it is.
		const opened = subscription.position;
		expect(opened).toBeDefined();

		await collection.create({ title: 'a', rank: 1 });
		await until(() => heard.length === 1, 'the create');
		expect(subscription.position).toEqual(subscription.resumeToken as never);

		// Nothing more happens, and the position still moves on.
		const handled = subscription.resumeToken;
		await until(
			() => subscription.position !== handled,
			'a position past the last change',
		);
		expect(subscription.resumeToken).toEqual(handled as never);

		// It is a token to resume from: the change after it is heard, that one is not.
		await collection.create({ title: 'b', rank: 2 });
		const after: string[] = [];
		track(
			collection.onChange((c) => void after.push(c.document?.title ?? ''), {
				startAfter: subscription.position,
			}),
		);
		await until(() => after.length === 1, 'the create after the position');
		expect(after).toEqual(['b']);
	});
});
