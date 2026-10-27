import type { SubscribeOptions, Subscription } from '../channel/pubsub';
import { createKeyedStreams } from '../channel/stream';
import { RedisError } from '../errors/redis-error';
import type { WiringContext } from './context';
import type { AnyChannel } from './types';

/** The stream hub of one bound channel, built on the first `open()`. */
export interface ChannelStreams {
	/** The hub, built on first call; throws when the channel has no `key`. */
	open(): ReturnType<typeof createKeyedStreams<unknown>>;
	/** The hub when one is open, else `undefined`. */
	current(): ReturnType<typeof createKeyedStreams<unknown>> | undefined;
	/** Stops the hub when one is open. */
	close(): Promise<void>;
}

/**
 * The stream hub of one channel: built on the first `open()`;
 * `redis.close()` stops it through `ctx.subscriptions`, like any
 * subscription nobody closed.
 */
export function streamsFor(
	ctx: WiringContext,
	definition: AnyChannel,
	bound: (payload: unknown) => Promise<number>,
	subscribe: (
		handler: (payload: never) => void | Promise<void>,
		options?: SubscribeOptions,
	) => Promise<Subscription>,
): ChannelStreams {
	let streams: ReturnType<typeof createKeyedStreams<unknown>> | undefined;
	let closeStreams: (() => Promise<void>) | undefined;
	const open = () => {
		const select = definition.key;
		if (select === undefined) {
			throw new TypeError(
				`channel "${definition.name}": stream() needs a \`key\` in its defineChannel`,
			);
		}
		if (streams !== undefined) return streams;
		const hub = createKeyedStreams<unknown>(
			{
				publish: bound,
				subscribe,
				parse: (message) => {
					const result = definition.schema.safeParse(message);
					if (!result.success) throw result.error;
					return result.data;
				},
				refuses: (error) =>
					error instanceof RedisError && error.code === 'INVALID',
			},
			(message) => select.call(definition, message),
			{ fallback: definition.fallback === 'local' },
		);
		streams = hub;
		const closeHub = () => {
			ctx.subscriptions.delete(registered);
			if (streams === hub) streams = undefined;
			return hub.close();
		};
		closeStreams = closeHub;
		const registered: Subscription = {
			channel: definition.name,
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
		open,
		current: () => streams,
		close: async () => {
			await closeStreams?.();
		},
	};
}
