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
import { openRedis } from '../../src/wiring/open-redis';
import type { CacheScope } from '../../src/wiring/scope-types';
import { userCache } from '../fixtures';
import * as caches from '../wiring/caches';
import * as everyKind from '../wiring/mixed';
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

// The package root exports the queue scope types.
type RootScope = import('../../src').QueueScope<
	import('../../src').QueuesOf<typeof queues>
>;
const rootMails: RootScope['mails']['definition']['name'] = 'mails';
type RootSole = import('../../src').SoleQueues<{
	uri: string;
	queues: typeof queues;
}>;
const rootSole: RootSole['mails']['definition']['name'] = 'mails';
type RootIn = import('../../src').QueuesIn<
	{ uri: string; queues: typeof queues },
	'default'
>;
const rootIn: keyof RootIn = 'mails';
void [rootMails, rootSole, rootIn];

async function wiredQueues() {
	const redis = await openRedis(defineRedis({ uri, queues }));

	// A queue that is not wired.
	// @ts-expect-error
	redis.queues.nope;

	// `mails` takes a string address, not a number.
	// @ts-expect-error
	await redis.queues.mails.add({ to: 1 });

	// A handler returns the result schema's shape.
	// @ts-expect-error
	redis.queues.mails.work(() => ({ messageId: 1 }));

	// `digest` has no result, so what it returns is not checked.
	redis.queues.digest.work(() => 'anything');

	// The result is typed by the definition: a string here, `undefined` there.
	const handle = await redis.queues.mails.add({ to: 'a@b.c' });
	const messageId: string = (await handle.finished()).messageId;
	void messageId;
	// @ts-expect-error `messageId` is a string, not a number
	const asNumber: number = (await handle.finished()).messageId;
	void asNumber;
	const none: undefined = await (
		await redis.queues.digest.add({ day: 'mon' })
	).finished();
	void none;

	// A handler sees the data the schema describes.
	redis.queues.mails.work((job) => {
		const address: string = job.data.to;
		// @ts-expect-error `to` is a string
		const wrong: number = job.data.to;
		void address;
		void wrong;
		return { messageId: 'm1' };
	});

	// An option the configuration does not have is Checked, beside `queues`.
	// @ts-expect-error
	defineRedis({ uri, queues, quues: {} });

	// A queue under `caches` is not a cache, and a cache is not wired on
	// `queues`; with a module of every kind each slot keeps only its own.
	const wrong = await openRedis(defineRedis({ uri, caches: queues }));
	// @ts-expect-error `mails` is a queue: not wired on `caches`
	wrong.cache.mails;
	const all = await openRedis(
		defineRedis({
			uri,
			caches: everyKind,
			channels: everyKind,
			queues: everyKind,
		}),
	);
	// @ts-expect-error `mails` is a queue: not wired on `channels`
	all.channels.mails;
	// @ts-expect-error `users` is a cache: not wired on `queues`
	all.queues.users;
	await all.queues.mails.add({ to: 'a@b.c' });

	// `grace` is a duration.
	// @ts-expect-error
	await redis.close({ grace: '10min' });

	// These must keep compiling.
	await redis.close({ grace: '10s' });
	await redis.close({ grace: 500 });
	await redis.close();
}

async function severalInstancesQueues() {
	const redis = await openRedis(
		defineRedis({
			instances: { a: { uri, queues }, b: { uri, caches } },
		}),
	);
	// `redis.queues` is `never` with more than one instance, as `redis.cache` is.
	const noQueues: never = redis.queues;
	void noQueues;
	// @ts-expect-error
	redis.queues.mails;
	// `b` wires no queue.
	// @ts-expect-error
	redis.instances.b.queues.mails;

	// These must keep compiling.
	await redis.instances.a.queues.mails.add({ to: 'a@b.c' });
	await redis.close();
}

export { severalInstancesQueues, wiredQueues };
