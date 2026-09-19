import { describe, expect, test } from 'bun:test';
import { stranger, useApi } from '../../../test/api';

/** This module's routes over HTTP, called as a client would call them. */
const { call } = useApi('blog-users-http');

describe('the user routes', () => {
	test('creates one and reads it back', async () => {
		const created = await call('/users', {
			method: 'POST',
			body: JSON.stringify({ email: 'ada@example.com', name: 'Ada' }),
		});
		expect(created.status).toBe(201);
		const user = (await created.json()) as { id: string };
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

	test('changes only the fields the patch names', async () => {
		const created = await call('/users', {
			method: 'POST',
			body: JSON.stringify({ email: 'ada@example.com', name: 'Ada' }),
		});
		const user = (await created.json()) as { id: string };

		const patched = await call(`/users/${user.id}`, {
			method: 'PATCH',
			body: JSON.stringify({ name: 'Ada Lovelace' }),
		});
		expect(patched.status).toBe(200);
		// The email it did not name is still there, and so is the count the
		// API never writes.
		expect(await patched.json()).toMatchObject({
			id: user.id,
			email: 'ada@example.com',
			name: 'Ada Lovelace',
			articles: 0,
		});
	});

	test('refuses a patch onto an email that is taken', async () => {
		await call('/users', {
			method: 'POST',
			body: JSON.stringify({ email: 'ada@example.com' }),
		});
		const second = await call('/users', {
			method: 'POST',
			body: JSON.stringify({ email: 'grace@example.com' }),
		});
		const grace = (await second.json()) as { id: string };

		const answer = await call(`/users/${grace.id}`, {
			method: 'PATCH',
			body: JSON.stringify({ email: 'ada@example.com' }),
		});
		expect(answer.status).toBe(409);
		expect(await answer.json()).toEqual({ message: 'errors.email-taken' });
	});

	test('patches no user that does not exist', async () => {
		const answer = await call(`/users/${stranger}`, {
			method: 'PATCH',
			body: JSON.stringify({ name: 'nobody' }),
		});
		expect(answer.status).toBe(404);
	});

	test('reads no user that does not exist', async () => {
		const answer = await call(`/users/${stranger}`);
		expect(answer.status).toBe(404);
	});
});
