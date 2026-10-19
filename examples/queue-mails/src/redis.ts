import { defineRedis, type RedisOf } from '@nxgt/redis';
import { env } from './env';
import * as queues from './mails';

/** What is wired, apart from where Redis is: the queues the module exports, under one prefix. */
export const wiring = { prefix: 'saas', queues };

/** The application's Redis, described once; it connects to nothing until `openRedis`. */
export const config = defineRedis({ uri: env.REDIS_URL, ...wiring });

/** The opened Redis, read from the configuration. */
export type AppRedis = RedisOf<typeof config>;
