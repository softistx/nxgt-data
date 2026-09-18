import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { useApi } from '../test/api';
import { assertServed } from './app';
import type { Env } from './context';

/**
 * The application itself: what every request goes through, and what the
 * mounted modules add up to. Each module measures its own routes beside
 * them, and the services are measured without a server at all.
 */
const { call } = useApi('blog-app');

describe('the application', () => {
	test('refuses a request that names no user', async () => {
		const answer = await call('/articles', { as: null });
		expect(answer.status).toBe(401);
		expect(await answer.json()).toEqual({ message: 'errors.unauthenticated' });
	});

	test('refuses a user id that is no id', async () => {
		const answer = await call('/articles', { as: 'not-an-id' });
		expect(answer.status).toBe(401);
	});

	test('refuses to start when a module is not mounted', () => {
		// `buildApp` ran this over the real app in `beforeAll`; here it is
		// given an app with nothing mounted, which is what a forgotten
		// `app.route(...)` leaves behind.
		expect(() => assertServed(new Hono<Env>())).toThrow(
			'The app serves no route for: createUser',
		);
	});
});
