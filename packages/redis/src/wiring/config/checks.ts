import {
	isCache,
	isChannel,
	isIdempotency,
	isQueue,
	isRateLimit,
	wiredOf,
} from './kinds';
import type { InstanceConfig } from './types';

/**
 * Refuses a configuration that cannot be honoured.
 *
 * A bare `TypeError`, with no code. Every refusal here is wiring-time — no
 * request can produce one — and there are few enough to tell apart by their
 * sentence, which is the rule in `AGENTS.md`. `@nxgt/mongo`'s wiring is the
 * exception to it because it has seven (`WiringError`);
 * `@nxgt/mongo-meilisearch`'s `createSearchSyncs`, the closer neighbour in
 * size, carries no error class either.
 */
export function checkInstance(
	call: 'defineRedis' | 'openRedis',
	name: string,
	instance: InstanceConfig<object, object, object, object, object>,
): void {
	// The call that raised it, not always `defineRedis`: the same checks run
	// again in `openRedis`, and a message naming a function the application
	// did not call sends a reader to the wrong file.
	const where = `${call}: instance "${name}"`;
	if (instance.uri === undefined && instance.client === undefined) {
		throw new TypeError(`${where} has neither uri nor client. Give it one.`);
	}
	if (instance.uri !== undefined && instance.client !== undefined) {
		throw new TypeError(
			`${where} has both uri and client. Pass the URI to connect to, or ` +
				'the client you already opened.',
		);
	}
	if (instance.client !== undefined && instance.clientOptions !== undefined) {
		throw new TypeError(
			`${where} has clientOptions beside a client. The client was opened ` +
				'with its own; pass a uri, or drop the options.',
		);
	}
	if (instance.prefix !== undefined && instance.prefix.trim() === '') {
		throw new TypeError(
			`${where} has an empty prefix. Leave it out, or give it a name.`,
		);
	}
	checkNothingWired(where, instance);
	checkPrefixBraces(where, instance);
	checkNoClash(where, instance);
}

function checkNothingWired(
	where: string,
	instance: InstanceConfig<object, object, object, object, object>,
): void {
	if (
		wiredOf(instance.caches, isCache).length === 0 &&
		wiredOf(instance.channels, isChannel).length === 0 &&
		wiredOf(instance.limits, isRateLimit).length === 0 &&
		wiredOf(instance.idempotency, isIdempotency).length === 0 &&
		wiredOf(instance.queues, isQueue).length === 0
	) {
		throw new TypeError(
			`${where} wires no cache, no channel, no rate limit, no idempotency ` +
				'and no queue. Pass the module that exports them, or drop the instance.',
		);
	}
}

/**
 * A queue's storage name, prefix included, is the hash tag of its keys, so a
 * brace in the prefix would split the tag. Instances without queues keep
 * accepting any prefix.
 */
function checkPrefixBraces(
	where: string,
	instance: InstanceConfig<object, object, object, object, object>,
): void {
	const { prefix } = instance;
	if (prefix === undefined || !/[{}]/.test(prefix)) return;
	if (wiredOf(instance.queues, isQueue).length === 0) return;
	throw new TypeError(
		`${where} has a prefix with braces, and it wires queues; a queue's ` +
			"name is its keys' hash tag, so the prefix in front of it cannot " +
			'hold any.',
	);
}

type Group = readonly [
	kind: string,
	wired: readonly (readonly [key: string, definition: { name: string }])[],
];

/**
 * Refuses a name used twice among `groups`.
 *
 * One definition under two keys: both would write the same Redis keys, so one
 * of them is silently dead — `redis.cache.a.delete(p)` empties what
 * `redis.cache.b.set(p, v)` wrote. A copy-paste in the module that exports
 * them, which nothing downstream can see.
 *
 * Two definitions of different kinds with one name, in the same group list:
 * a cache, a rate limit and an idempotency all write `<name>:<key>`, so they
 * would meet in Redis: an idempotency's hash as `WRONGTYPE`, and a cache's
 * and a rate limit's strings overwriting each other. A queue's keys
 * (`queue:{<name>}:…`) do not meet them byte for byte; it is refused anyway,
 * so one name means one thing per deployment. Only names
 * are compared — never what a key function would build.
 */
function refuseClash(where: string, groups: readonly Group[]): void {
	const seen = new Map<string, { kind: string; key: string }>();
	for (const [kind, wired] of groups) {
		for (const [key, definition] of wired) {
			const first = seen.get(definition.name);
			if (first === undefined) {
				seen.set(definition.name, { kind, key });
			} else if (first.kind === kind) {
				throw new TypeError(
					`${where} wires the ${kind} named "${definition.name}" twice, ` +
						`under "${first.key}" and "${key}". They would share every key ` +
						'in Redis. Export one of them, or give it a name of its own.',
				);
			} else {
				throw new TypeError(
					`${where} wires the ${first.kind} "${first.key}" and the ${kind} ` +
						`"${key}" under one name, "${definition.name}". They would share ` +
						'every key in Redis. Give one of them a name of its own.',
				);
			}
		}
	}
}

/**
 * Channels have a namespace of their own — pub/sub names are not keys — so
 * they are checked among themselves, and a channel named like a cache is fine.
 */
function checkNoClash(
	where: string,
	instance: InstanceConfig<object, object, object, object, object>,
): void {
	refuseClash(where, [
		['cache', wiredOf(instance.caches, isCache)],
		['rate limit', wiredOf(instance.limits, isRateLimit)],
		['idempotency', wiredOf(instance.idempotency, isIdempotency)],
		['queue', wiredOf(instance.queues, isQueue)],
	]);
	refuseClash(where, [['channel', wiredOf(instance.channels, isChannel)]]);
}
