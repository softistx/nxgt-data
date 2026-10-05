import { openMongo } from '@nxgt/mongo';
import { openRedis } from '@nxgt/redis';
import { serve } from 'bun';
import { buildApp } from './app';
import { config } from './db';
import { env } from './env';
import { config as redisConfig } from './redis';

/**
 * The server: `bun run dev`, then
 * `curl -H 'x-user-id: …' http://localhost:3000/articles`.
 *
 * The Mongo and the Redis client are opened once, here, and closed with the
 * process — never per request, which would open a client per request.
 */
const mongo = await openMongo(config);

// The Redis, opened once like the Mongo: it binds every guard the modules
// export, under the deployment's prefix, and closes the client it opened.
const redis = await openRedis(redisConfig);

const server = serve({
	fetch: buildApp(mongo, redis).fetch,
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
			.then(async () => {
				await redis.close();
				return mongo.close();
			})
			.finally(() => process.exit(0));
	});
}
