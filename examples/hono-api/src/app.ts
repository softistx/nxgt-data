import { tryObjectId } from '@nxgt/mongo';
import { Hono } from 'hono';
import { api } from './api';
import { buildServices, type Env } from './context';
import type { Kit } from './db';
import { operations } from './generated/operations';
import { articlesApp } from './modules/articles/articles.route';
import { usersApp } from './modules/users/users.route';

/**
 * Throws unless the assembled app answers at every path the spec declares.
 *
 * `api.assertComplete()` is not enough on its own: a module registers its
 * routes as it is imported, so the registry is complete the moment the file
 * is loaded — whatever `buildApp` then does with the module's app. This
 * reads the app itself, so a module mounted under the wrong prefix, or not
 * mounted at all, is a startup error rather than a 404 in production.
 */
export function assertServed(app: Hono<Env>): void {
	const served = new Set(
		app.routes.map((route) => `${route.method.toLowerCase()} ${route.path}`),
	);
	const missing = Object.entries(operations)
		.filter(
			([, operation]) =>
				!served.has(`${operation.method} ${operation.honoPath}`),
		)
		.map(([id]) => id);
	if (missing.length > 0) {
		throw new Error(`The app serves no route for: ${missing.join(', ')}`);
	}
}

/**
 * The application, over a kit the caller opened. The kit is still an
 * argument — that is what lets the specs run it against a server of their
 * own — but no module is handed anything: each exports its own app, and
 * this file only mounts them and says what every request carries.
 */
export function buildApp(kit: Kit): Hono<Env> {
	const app = new Hono<Env>();

	// One kit per request: `as` gives another kit over the same clients, so
	// every collection a service touches stamps this user, and the kit the
	// application opened is left as it was.
	app.use('*', async (c, next) => {
		const actor = tryObjectId(c.req.header('x-user-id'));
		if (!actor) return c.json({ message: 'errors.unauthenticated' }, 401);
		c.set('services', buildServices(kit.as(actor)));
		await next();
	});

	// Mount order decides which module answers a path two of them could
	// match; today no path of the spec shadows another.
	app.route('/', usersApp);
	app.route('/', articlesApp);

	// One operation nobody wrote a handler for, then one module nobody
	// mounted: the two ways the spec and the app can drift apart.
	api.assertComplete();
	assertServed(app);

	return app;
}
