import { connectRedis, type RedisConnection } from '@nxgt/redis';
import { checkInstance, isCache, isChannel, wiredOf } from '../config/checks';
import type { InstanceConfig, KitConfig } from '../config/types';
import type { InstanceContext, KitContext } from './context';
import { kitOf } from './kit-of';
import type { AnyCache, AnyChannel, RedisKit } from './types';

async function open(
	name: string,
	instance: InstanceConfig<object, object>,
): Promise<InstanceContext> {
	let connection: RedisConnection | undefined;
	if (instance.uri !== undefined) {
		connection = await connectRedis(instance.uri, instance.clientOptions);
	}
	const client = connection?.client ?? instance.client;
	if (!client) {
		// Unreachable: `checkInstance` runs on every instance in the same loop,
		// just before this, and refuses one with neither — from `defineConfig`
		// or from here, whichever the application called. This is what narrows
		// `client` for the return below, and the sentence is what a reader
		// would see if that check ever moved.
		throw new TypeError(
			`connectKit: instance "${name}" has neither uri nor client.`,
		);
	}
	return {
		name,
		client,
		prefix: instance.prefix,
		caches: wiredOf<AnyCache>(instance.caches, isCache),
		channels: wiredOf<AnyChannel>(instance.channels, isChannel),
		connection,
	};
}

/**
 * Opens every client the configuration names, and gives back the kit.
 *
 * ```ts
 * import * as caches from './caches';
 * import * as channels from './channels';
 *
 * export const kit = await connectKit(
 *   defineConfig({ uri: process.env.REDIS_URL!, caches, channels }),
 * );
 *
 * await kit.cache.sessions.remember({ userId }, () => load(userId));
 * await kit.channels.users.publish({ id: userId, event: 'created' });
 * ```
 *
 * `connectKit`, not `createKit`: `AGENTS.md` reserves `create*` for an
 * assembly that does no I/O, and says in as many words that
 * `@nxgt/mongo-kit`'s `createKit` is the one exception and not a licence for
 * a second. This one opens connections, so it takes the verb that says so.
 *
 * The checks run here as well as in `defineConfig`: a configuration is often
 * built in one file and connected in another, and this is the call a stack
 * trace points at. If one instance fails to open, the ones already open are
 * closed before the error leaves.
 */
export async function connectKit<C>(
	config: KitConfig<C>,
): Promise<RedisKit<C>> {
	const entries = Object.entries(config.instances) as [
		string,
		InstanceConfig<object, object>,
	][];
	const instances: InstanceContext[] = [];
	try {
		for (const [name, instance] of entries) {
			checkInstance('connectKit', name, instance);
			instances.push(await open(name, instance));
		}
	} catch (error) {
		for (const opened of instances) await opened.connection?.close();
		throw error;
	}
	const ctx: KitContext = {
		instances,
		caches: new Map(),
		channels: new Map(),
		subscriptions: new Set(),
	};
	return kitOf<C>(ctx);
}
