import { ConflictError, tryObjectId } from '@nxgt/mongo';
import { Hono } from 'hono';
import { api } from '../../api';
import type { Env } from '../../context';
import type { User } from '../../generated/types';
import type { User as StoredUser } from './users.service';

/**
 * The stored document is not the API document: `_id` is an `ObjectId` and
 * the stamps are `Date`s, while the spec says strings. The mapping is the
 * controller's, written once, which keeps the two free to differ.
 */
function toUser(user: StoredUser): User {
	return {
		id: user.id,
		email: user.email,
		...(user.name === undefined ? {} : { name: user.name }),
		articles: user.articles,
		createdAt: user.createdAt.toISOString(),
	};
}

/**
 * The module's own app, mounted by `app.ts`. It is exported rather than
 * taken as an argument, so this file is the whole of what the module serves
 * and nothing has to be handed to it.
 */
export const router = new Hono<Env>();

// `tag: 'users'` bounds the registry to this module's operations: a route of
// another module does not compile here, and `api.missing('users')` names
// what this file still owes the spec.
const routes = api.routes(router, { tag: 'users' });

routes.post('/users', async (c) => {
	try {
		// `c.req.valid('json')` is the body the spec describes, already checked.
		const user = await c.get('services').users.create(c.req.valid('json'));
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
	const user = id ? await c.get('services').users.find(id) : undefined;
	if (!user) return c.json({ message: 'errors.not-found' }, 404);
	return c.json(toUser(user), 200);
});
