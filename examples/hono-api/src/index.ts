import { createKit } from '@nxgt/mongo-kit';
import { buildApp } from './app';
import { config } from './db';

/**
 * The server. Bun reads this default export: `bun run dev`, then
 * `curl -H 'x-user-id: …' http://localhost:3000/articles`.
 *
 * The kit is opened once, here, and closed with the process — never per
 * request, which would open a client per request.
 */
const kit = await createKit(config);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		void kit.close().finally(() => process.exit(0));
	});
}

export default {
	port: Number(process.env.PORT ?? 3000),
	fetch: buildApp(kit).fetch,
};
