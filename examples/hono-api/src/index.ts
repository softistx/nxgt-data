import { createKit } from '@nxgt/mongo-kit';
import { serve } from 'bun';
import { buildApp } from './app';
import { config } from './db';
import { env } from './env';

/**
 * The server: `bun run dev`, then
 * `curl -H 'x-user-id: …' http://localhost:3000/articles`.
 *
 * The kit is opened once, here, and closed with the process — never per
 * request, which would open a client per request.
 */
const kit = await createKit(config);

const server = serve({
	fetch: buildApp(kit).fetch,
	// The port is the parsed one, so `PORT=abc` is a startup error rather
	// than a silent fall back to Bun's own reading of the variable.
	port: env.PORT,
	hostname: '0.0.0.0',
	development: env.NODE_ENV !== 'production' && {
		// Enable browser hot reloading in development
		hmr: true,

		// Echo console logs from the browser to the server
		console: true,
	},
});

console.log(`🚀 Server running at ${server.url} ${env.NODE_ENV}`);

// Stop listening, let the requests in flight finish, then hand the clients
// back. A container that is killed instead loses nothing: MongoDB is not
// holding a transaction this process alone knows about.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		void server
			.stop()
			.then(() => kit.close())
			.finally(() => process.exit(0));
	});
}
