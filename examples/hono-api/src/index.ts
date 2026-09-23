import { createKit } from '@nxgt/mongo-kit';
import { RedisClient, serve } from 'bun';
import { buildApp } from './app';
import { config } from './db';
import { env } from './env';

/**
 * The server: `bun run dev`, then
 * `curl -H 'x-user-id: …' http://localhost:3000/articles`.
 *
 * The kit and the Redis client are opened once, here, and closed with the
 * process — never per request, which would open a client per request.
 */
const kit = await createKit(config);

// Bun's own client, opened once like the kit. `@nxgt/redis-guard` opens no
// connection of its own: every guard is bound to this one.
const redis = new RedisClient(env.REDIS_URL);
await redis.connect();

const server = serve({
	fetch: buildApp(kit, redis).fetch,
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
// holding a transaction this process alone knows about, and an idempotency
// key a killed request held is free again when its lease lapses.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		void server
			.stop()
			.then(() => {
				redis.close();
				return kit.close();
			})
			.finally(() => process.exit(0));
	});
}
