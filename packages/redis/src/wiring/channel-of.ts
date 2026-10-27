import {
	publish,
	type SubscribeOptions,
	type Subscription,
	subscribe,
} from '../channel/pubsub';
import { createKeyedStreams } from '../channel/stream';
import { RedisError } from '../errors/redis-error';
import type { InstanceContext, WiringContext } from './context';
import type { AnyChannel, BoundChannel } from './types';
import { underPrefix } from './under-prefix';

/** One bound channel: publish, and a subscribe the Redis keeps track of. */
export function channelOf(
	ctx: WiringContext,
	instance: InstanceContext,
	definition: AnyChannel,
): BoundChannel<AnyChannel> {
	const prefixedDefinition = underPrefix(instance, definition);
	const bound = (payload: unknown) =>
		publish(instance.client, prefixedDefinition, payload as never);
	const subscribeBound = async (
		handler: (payload: never) => void | Promise<void>,
		options?: SubscribeOptions,
	): Promise<Subscription> => {
		const subscription = await subscribe(
			instance.client,
			prefixedDefinition,
			handler as (payload: unknown) => void | Promise<void>,
			options,
		);
		// Recorded so `redis.close()` closes the ones nobody did. Closing it
		// twice is safe: `@nxgt/redis` memoises its `close`.
		ctx.subscriptions.add(subscription);
		const forget = async () => {
			ctx.subscriptions.delete(subscription);
			await subscription.close();
		};
		// `Object.create`, not a spread: a spread would snapshot the
		// sibling's members, and the day `@nxgt/redis` puts a live one on a
		// `Subscription` — a `closed` promise, a counter — the copy would
		// freeze it without a word. The prototype keeps everything but the
		// two this layer replaces.
		return Object.create(subscription, {
			close: { enumerable: true, value: forget },
			[Symbol.asyncDispose]: { enumerable: false, value: forget },
		}) as Subscription;
	};
	// Built on the first `stream()`; `redis.close()` stops it through
	// `ctx.subscriptions`, like any subscription nobody closed.
	let streams: ReturnType<typeof createKeyedStreams<unknown>> | undefined;
	let closeStreams: (() => Promise<void>) | undefined;
	const streamsOf = () => {
		const select = prefixedDefinition.key;
		if (select === undefined) {
			throw new TypeError(
				`channel "${prefixedDefinition.name}": stream() needs a \`key\` in its defineChannel`,
			);
		}
		if (streams !== undefined) return streams;
		const hub = createKeyedStreams<unknown>(
			{
				publish: bound,
				subscribe: subscribeBound,
				parse: (message) => {
					const result = prefixedDefinition.schema.safeParse(message);
					if (!result.success) throw result.error;
					return result.data;
				},
				refuses: (error) =>
					error instanceof RedisError && error.code === 'INVALID',
			},
			(message) => select.call(prefixedDefinition, message),
			{ fallback: prefixedDefinition.fallback === 'local' },
		);
		streams = hub;
		const closeHub = () => {
			ctx.subscriptions.delete(registered);
			if (streams === hub) streams = undefined;
			return hub.close();
		};
		closeStreams = closeHub;
		const registered: Subscription = {
			channel: prefixedDefinition.name,
			close: closeHub,
			[Symbol.asyncDispose]: closeHub,
		};
		// A Redis already closing ends its streams at once: they would wait
		// for a close that has come and gone.
		if (ctx.closing !== undefined) void closeHub();
		else ctx.subscriptions.add(registered);
		return hub;
	};
	return {
		definition: prefixedDefinition,
		name: prefixedDefinition.name,
		// With streams open in this process, a publish Redis refuses reaches
		// them anyway; otherwise it is what `publish` does.
		publish: (payload) =>
			streams === undefined ? bound(payload) : streams.publish(payload),
		stream: (key, options) => streamsOf().stream(key, options) as never,
		close: async () => {
			await closeStreams?.();
		},
		subscribe: subscribeBound,
	};
}
