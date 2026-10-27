import {
	publish,
	type SubscribeOptions,
	type Subscription,
	subscribe,
} from '../channel/pubsub';
import { streamsFor } from './channel-streams';
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
	const hub = streamsFor(ctx, prefixedDefinition, bound, subscribeBound);
	return {
		definition: prefixedDefinition,
		name: prefixedDefinition.name,
		// With streams open in this process, a publish Redis refuses reaches
		// them anyway; otherwise it is what `publish` does.
		publish: (payload) => {
			const open = hub.current();
			return open === undefined ? bound(payload) : open.publish(payload);
		},
		stream: (key, options) => hub.open().stream(key, options) as never,
		close: hub.close,
		subscribe: subscribeBound,
	};
}
