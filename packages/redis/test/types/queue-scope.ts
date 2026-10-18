/**
 * What the queue scope keeps and refuses. Checked by `tsc --noEmit`, never
 * run: a `@ts-expect-error` that stops being an error fails the build.
 */

import { defineRedis } from '../../src/wiring/config/define-redis';
import type {
	CachesIn,
	CachesOf,
	QueuesIn,
	QueuesOf,
} from '../../src/wiring/config/types';
import type { CacheScope } from '../../src/wiring/scope-types';
import { userCache } from '../fixtures';
import * as queues from '../wiring/queues';

const uri = 'redis://127.0.0.1:6379';

// A module that exports queues and a type keeps its queues, and only them:
// `Delivery` is a type, not a value, so it is not in the scope.
type Kept = keyof QueuesOf<typeof queues>;
const kept: Kept[] = ['mails', 'digest'];
void kept;
const allKept: 'mails' | 'digest' extends Kept ? true : never = true;
void allKept;
const noExtra: Kept extends 'mails' | 'digest' ? true : never = true;
void noExtra;
// @ts-expect-error `Delivery` is a type export: it is no key of the scope
type NotAKey = QueuesOf<typeof queues>['Delivery'];

// An export that is not a queue is skipped, a cache beside them included.
const mixed = { ...queues, users: userCache, version: 1 };
const onlyQueues: keyof QueuesOf<typeof mixed> extends 'mails' | 'digest'
	? true
	: never = true;
void onlyQueues;
// @ts-expect-error a cache is not a queue
type CacheAsQueue = QueuesOf<typeof mixed>['users'];
// @ts-expect-error a number is not a queue
type NumberAsQueue = QueuesOf<typeof mixed>['version'];

// A queue under `caches` is refused: the cache scope keeps none of them.
// @ts-expect-error `mails` is a queue, not a cache
type QueueAsCache = CachesOf<typeof queues>['mails'];

// A queue under `caches` is wired as nothing, and under `queues` as itself.
const wrong = defineRedis({ uri, caches: queues });
// @ts-expect-error `mails` is no key of that instance's cache scope: it wires no queue as a cache
type WrongScope = CacheScope<CachesIn<typeof wrong, 'default'>>['mails'];
defineRedis({ uri, queues });
const wired: QueuesIn<{ uri: string; queues: typeof queues }, 'default'> =
	queues;
void wired;

export type { CacheAsQueue, NotAKey, NumberAsQueue, QueueAsCache, WrongScope };
