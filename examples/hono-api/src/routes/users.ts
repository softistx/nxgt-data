import { ConflictError, type ReadDocumentOf, tryObjectId } from '@nxgt/mongo';
import type { Hono } from 'hono';
import type { Env } from '../app';
import type { createApi } from '../generated/hono';
import type { User } from '../generated/types';
import type { users } from '../models/user.model';

/**
 * The stored document is not the API document: `_id` is an `ObjectId` and
 * the stamps are `Date`s, while the spec says strings. Writing the mapping
 * once, here, is what keeps the two free to differ.
 */
export function toUser(user: ReadDocumentOf<typeof users>): User {
	return {
		id: user.id,
		email: user.email,
		...(user.name === undefined ? {} : { name: user.name }),
		articles: user.articles,
		createdAt: user.createdAt.toISOString(),
	};
}

export function userRoutes(
	app: Hono<Env>,
	api: ReturnType<typeof createApi>,
): void {
	const routes = api.routes(app);

	routes.post('/users', async (c) => {
		try {
			// `c.req.valid('json')` is the body the spec describes, already checked.
			const user = await c.get('db').users.create(c.req.valid('json'));
			return c.json(toUser(user), 201);
		} catch (error) {
			// The unique index on `email` is what refuses a second one, and
			// `@nxgt/mongo` turns MongoDB's 11000 into this.
			if (error instanceof ConflictError) {
				return c.json({ message: 'errors.email-taken' }, 409);
			}
			throw error;
		}
	});

	routes.get('/users/{id}', async (c) => {
		const id = tryObjectId(c.req.valid('param').id);
		const user = id ? await c.get('db').users.findById(id) : null;
		if (!user) return c.json({ message: 'errors.not-found' }, 404);
		return c.json(toUser(user), 200);
	});
}
