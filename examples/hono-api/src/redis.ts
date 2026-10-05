import { defineRedis, type RedisOf } from '@nxgt/redis';
import { env } from './env';
import {
	articleCreation,
	articleWrites,
} from './modules/articles/articles.guards';

/**
 * What is wired on the application's Redis, apart from where it is: the guards
 * each module exports, gathered the way `collections.ts` gathers the models.
 * `prefix` is the deployment's — every key a guard writes starts with it, so
 * this API can share a Redis with another without sharing a bucket.
 */
export const wiring = {
	prefix: 'blog',
	limits: { articleWrites },
	idempotency: { articleCreation },
};

/**
 * The application's Redis, described once. It connects to nothing, and it
 * reads no variable of its own: `env.REDIS_URL` was parsed and defaulted
 * before this module was evaluated.
 */
export const config = defineRedis({ uri: env.REDIS_URL, ...wiring });

/** This application's Redis, read from the configuration rather than written twice. */
export type AppRedis = RedisOf<typeof config>;
