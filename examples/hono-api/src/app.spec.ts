import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { join } from 'node:path';
import { closeMongo } from '@nxgt/mongo';
import { createKit, defineConfig } from '@nxgt/mongo-kit';
import type { Hono } from 'hono';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import { buildApp, type Env, type Kit } from './app';
import * as collections from './models';

/**
 * The same mongod the packages' specs use — a single-node replica set,
 * because `createArticle` runs in a transaction. Keep the version equal to the
 * copies under `packages`, in each `test/server.ts`: CI caches the binary on
 * the hash of them all.
 */
const MONGOD_VERSION = '8.2.6';

let replSet: MongoMemoryReplSet;
let kit: Kit;
let app: Hono<Env>;

const author = '68ca1f0f2b1c4d5e6f7a8b90';

/** A request, as a client would send it. */
const call = (path: string, init: RequestInit & { as?: string } = {}) =>
	app.request(path, {
		...init,
		headers: {
			'content-type': 'application/json',
			...(init.as === undefined
				? { 'x-user-id': author }
				: { 'x-user-id': init.as }),
			...init.headers,
		},
	});

beforeAll(async () => {
	replSet = await MongoMemoryReplSet.create({
		replSet: { count: 1, storageEngine: 'wiredTiger' },
		binary: {
			version: MONGOD_VERSION,
			downloadDir: join(
				new URL('../../..', import.meta.url).pathname,
				'.cache',
				'mongodb',
			),
		},
		instanceOpts: [{ launchTimeout: 60_000 }],
	});
	kit = await createKit(
		defineConfig({
			uri: replSet.getUri('blog'),
			collections,
			options: { maxPageSize: 50 },
		}),
	);
	app = buildApp(kit);
});

beforeEach(async () => {
	await kit.db.dropDatabase();
	// What `bun run sync` does on a deployment. `autoSync` would not do here:
	// it syncs once per collection and per process, and the drop above takes
	// the indexes with it.
	await kit.sync();
});

afterAll(async () => {
	await kit.close();
	await closeMongo();
	await replSet.stop({ doCleanup: true });
});

/** The example is the documentation, so the specs read as a client would. */
describe('the blog', () => {
	test('refuses a request that names no user', async () => {
		const answer = await app.request('/articles');
		expect(answer.status).toBe(401);
		expect(await answer.json()).toEqual({ message: 'errors.unauthenticated' });
	});

	test('creates a user and reads it back', async () => {
		const created = await call('/users', {
			method: 'POST',
			body: JSON.stringify({ email: 'ada@example.com', name: 'Ada' }),
		});
		expect(created.status).toBe(201);
		const user = (await created.json()) as { id: string; articles: number };
		expect(user).toMatchObject({
			email: 'ada@example.com',
			name: 'Ada',
			articles: 0,
		});

		const read = await call(`/users/${user.id}`);
		expect(read.status).toBe(200);
		expect(await read.json()).toMatchObject({ id: user.id });
	});

	test('refuses a second user on one email', async () => {
		const body = JSON.stringify({ email: 'ada@example.com' });
		await call('/users', { method: 'POST', body });
		const again = await call('/users', { method: 'POST', body });
		expect(again.status).toBe(409);
		expect(await again.json()).toEqual({ message: 'errors.email-taken' });
	});

	test('refuses a body the spec does not allow', async () => {
		const answer = await call('/users', {
			method: 'POST',
			body: JSON.stringify({ email: 'not-an-email' }),
		});
		expect(answer.status).toBe(400);
		expect(await answer.json()).toMatchObject({
			message: 'errors.validation-failed',
		});
	});

	test('reads no user that does not exist', async () => {
		const answer = await call(`/users/${author}`);
		expect(answer.status).toBe(404);
	});

	describe('writing an article', () => {
		let userId: string;

		beforeEach(async () => {
			const created = await call('/users', {
				method: 'POST',
				body: JSON.stringify({ email: 'ada@example.com' }),
			});
			userId = ((await created.json()) as { id: string }).id;
		});

		test('stamps the author and raises their count, in one transaction', async () => {
			const written = await call('/articles', {
				method: 'POST',
				as: userId,
				body: JSON.stringify({ title: 'On wiring', body: 'One object.' }),
			});
			expect(written.status).toBe(201);
			expect(await written.json()).toMatchObject({
				title: 'On wiring',
				authorId: userId,
			});

			const read = await call(`/users/${userId}`, { as: userId });
			expect(await read.json()).toMatchObject({ articles: 1 });
		});

		test('writes nothing at all when the author is gone', async () => {
			const answer = await call('/articles', {
				method: 'POST',
				as: author,
				body: JSON.stringify({ title: 'a', body: 'b' }),
			});
			expect(answer.status).toBe(404);
			expect(await kit.db.articles.count()).toBe(0);
		});

		test('lists them most recent first, and pages', async () => {
			for (const title of ['one', 'two', 'three']) {
				await call('/articles', {
					method: 'POST',
					as: userId,
					body: JSON.stringify({ title, body: 'b' }),
				});
			}
			const answer = await call('/articles?pageSize=2', { as: userId });
			expect(answer.status).toBe(200);
			const page = (await answer.json()) as {
				items: { title: string }[];
				total: number;
				pageCount: number;
			};
			expect(page.items.map((item) => item.title)).toEqual(['three', 'two']);
			expect(page).toMatchObject({ total: 3, pageCount: 2 });
		});

		test('takes an article back, and keeps it', async () => {
			const written = await call('/articles', {
				method: 'POST',
				as: userId,
				body: JSON.stringify({ title: 'a', body: 'b' }),
			});
			const { id } = (await written.json()) as { id: string };

			const removed = await call(`/articles/${id}`, {
				method: 'DELETE',
				as: userId,
			});
			expect(removed.status).toBe(204);

			const list = await call('/articles', { as: userId });
			expect((await list.json()) as { total: number }).toMatchObject({
				total: 0,
			});
			// Soft delete: the document is still there, with the time it went.
			expect(await kit.db.articles.raw.countDocuments()).toBe(1);
		});

		test('answers 404 for an article that is already gone', async () => {
			const answer = await call(`/articles/${author}`, {
				method: 'DELETE',
				as: userId,
			});
			expect(answer.status).toBe(404);
		});
	});
});
