import { defineConfig, type KitOf } from '@nxgt/mongo-kit';
import * as collections from './collections';
import { env } from './env';

/**
 * The application's MongoDB, described once. It connects to nothing, and it
 * reads no variable of its own: `env.MONGO_URI` was parsed and defaulted
 * before this module was evaluated.
 */
export const config = defineConfig({
	uri: env.MONGO_URI,
	collections,
	options: { maxPageSize: 50 },
});

/** This application's kit, read from the configuration rather than written twice. */
export type Kit = KitOf<typeof config>;
