import { tryObjectId } from '@nxgt/mongo';
import type { KitOf } from '@nxgt/mongo-kit';
import { Hono } from 'hono';
import type { ObjectId } from 'mongodb';
import type { config } from './db';
import { createApi } from './generated/hono';
import { articleRoutes } from './routes/articles';
import { userRoutes } from './routes/users';

/** This application's kit, read from the configuration rather than written twice. */
export type Kit = KitOf<typeof config>;

/**
 * What a handler finds on the context: the collections, already carrying the
 * user of this request. A handler never sees the kit itself, so it cannot
 * write as anyone else — and cannot close it.
 */
export interface Env {
	Variables: {
		actor: ObjectId;
		/** The collections, as this user. What a handler reads and writes. */
		db: Kit['db'];
		/** The same kit, for the one thing a scope cannot do: a transaction. */
		kit: Kit;
	};
}

/**
 * The application, over a kit the caller opened. Taking the kit as an
 * argument is what lets the specs run it against a server of their own.
 */
export function buildApp(kit: Kit): Hono<Env> {
	const app = new Hono<Env>();

	// One kit per request: `as` gives another kit over the same clients, so
	// every collection this request touches stamps this user, and the kit the
	// application opened is left as it was.
	app.use('*', async (c, next) => {
		const actor = tryObjectId(c.req.header('x-user-id'));
		if (!actor) return c.json({ message: 'errors.unauthenticated' }, 401);
		const asUser = kit.as(actor);
		c.set('actor', actor);
		c.set('kit', asUser);
		c.set('db', asUser.db);
		await next();
	});

	// One registry for the whole spec: each module registers its own routes,
	// and `assertComplete` refuses to start with an operation nobody serves.
	const api = createApi({
		// Every reply is checked against the spec. It reads each body twice, so
		// it is for development and tests, never for production.
		validateResponses: process.env.NODE_ENV !== 'production',
	});
	userRoutes(app, api);
	articleRoutes(app, api);
	api.assertComplete();

	return app;
}
