import { describe, expect, test } from 'bun:test';
import { stranger, useApi } from '../../../test/api';

const { call, newUser } = useApi('blog-articles-http');

describe('the article routes', () => {
	test('writes one as the user the request carries', async () => {
		const userId = await newUser();
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

	test('answers 404 when the author is gone', async () => {
		const answer = await call('/articles', {
			method: 'POST',
			body: JSON.stringify({ title: 'a', body: 'b' }),
		});
		expect(answer.status).toBe(404);
		expect(await answer.json()).toEqual({ message: 'errors.no-such-author' });
	});

	test('pages the list', async () => {
		const userId = await newUser();
		for (const title of ['one', 'two', 'three']) {
			await call('/articles', {
				method: 'POST',
				as: userId,
				body: JSON.stringify({ title, body: 'b' }),
			});
		}
		const answer = await call('/articles?pageSize=2', { as: userId });
		expect(answer.status).toBe(200);
		const page = (await answer.json()) as { items: { title: string }[] };
		expect(page.items.map((item) => item.title)).toEqual(['three', 'two']);
		expect(page).toMatchObject({ total: 3, pageCount: 2 });
	});

	test('refuses a page the spec does not allow', async () => {
		const answer = await call('/articles?pageSize=0');
		expect(answer.status).toBe(400);
	});

	test('takes an article back', async () => {
		const userId = await newUser();
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
		expect(await list.json()).toMatchObject({ total: 0 });
	});

	test('changes one, and leaves what the patch does not name', async () => {
		const userId = await newUser();
		const written = await call('/articles', {
			method: 'POST',
			as: userId,
			body: JSON.stringify({ title: 'a', body: 'b' }),
		});
		const { id, createdAt } = (await written.json()) as {
			id: string;
			createdAt: string;
		};

		const patched = await call(`/articles/${id}`, {
			method: 'PATCH',
			as: userId,
			body: JSON.stringify({ title: 'A better title' }),
		});
		expect(patched.status).toBe(200);
		expect(await patched.json()).toMatchObject({
			id,
			title: 'A better title',
			body: 'b',
			// `createdAt` never moves: only `updatedAt` does, and the spec
			// does not publish it.
			createdAt,
			authorId: userId,
		});
	});

	test('answers 404 for an article that is already gone', async () => {
		const answer = await call(`/articles/${stranger}`, { method: 'DELETE' });
		expect(answer.status).toBe(404);
	});

	test('patches no article that is not there', async () => {
		const answer = await call(`/articles/${stranger}`, {
			method: 'PATCH',
			body: JSON.stringify({ title: 'nobody' }),
		});
		expect(answer.status).toBe(404);
	});
});
