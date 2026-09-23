import type { RedisClient } from 'bun';
import { Hono } from 'hono';
import { api } from './api';
import { bindGuards, type Env, type GuardOptions } from './context';
import type { Kit } from './db';
import { operations } from './generated/operations';
import { provideGuards, provideServices } from './middlewares';
import { routes } from './modules';

/**
 * Throws unless the assembled app answers at every path the spec declares.
 *
 * `api.assertComplete()` is not enough on its own: a module registers its
 * routes as it is imported, so the registry is complete the moment the file
 * is loaded — whatever `buildApp` then does with the module's app. This
 * reads the app itself, so a module missing from `routes`, or mounted under
 * the wrong prefix, is a startup error rather than a 404 in production.
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
 * The application, over a kit and a Redis the caller opened. Both are still
 * arguments — that is what lets the specs run it against servers of their
 * own — but no module is handed anything: each exports its own app, and
 * this file only mounts them and says what every request carries.
 */
export function buildApp(
	kit: Kit,
	redis: RedisClient,
	options: GuardOptions = {},
): Hono<Env> {
	const app = new Hono<Env>();

	app.use(provideServices(kit));
	app.use(provideGuards(bindGuards(redis, options)));

	// `routes` is an object literal, so its values keep the order they were
	// written in: that is what decides which module answers a path two of
	// them could match. Today no path of the spec shadows another.
	for (const router of Object.values(routes)) {
		app.route('/', router);
	}

	// One operation nobody wrote a handler for, then one module nobody added
	// to `routes`: the two ways the spec and the app can drift apart.
	api.assertComplete();
	assertServed(app);

	return app;
}
