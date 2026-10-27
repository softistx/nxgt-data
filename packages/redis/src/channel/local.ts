import { RedisError } from '../errors/redis-error';
import { isChannel } from '../wiring/config/kinds';
import type { ChannelScope } from '../wiring/scope-types';
import type { AnyChannel } from '../wiring/types';
import type { SubscribeOptions, Subscription } from './pubsub';
import { createKeyedStreams, type KeyedStreams } from './stream';

/** What `localChannels` gives back: the bound channels, and one `close`. */
export interface LocalChannels<Ch> {
	/** The same surface a Redis's `channels` has: `publish`, `subscribe`, `stream(key)`, `close()`. */
	readonly channels: ChannelScope<Ch>;
	/** Stops every stream and subscription of every channel. Idempotent. */
	close(): Promise<void>;
}

type Handler = (message: unknown) => void;

/** One channel on an in-process transport: no client, no connection. */
function localChannel(
	definition: AnyChannel,
	closers: Set<() => Promise<void>>,
) {
	const handlers = new Set<Handler>();
	const publish = async (payload: unknown): Promise<number> => {
		const result = definition.schema.safeParse(payload);
		if (!result.success) {
			throw new RedisError(
				'INVALID',
				definition.name,
				`This message does not match the schema "${definition.name}" carries: ` +
					result.error.issues.map((issue) => issue.message).join('; '),
				{ cause: result.error },
			);
		}
		// What a subscriber of a real Redis gets: the message as JSON,
		// parsed by the schema again on the way in.
		const wire = JSON.stringify(result.data);
		for (const handler of [...handlers]) handler(wire);
		return handlers.size;
	};
	const attach = (
		deliver: (message: unknown) => void | Promise<void>,
		options: SubscribeOptions = {},
	) => {
		const onError =
			options.onError ??
			((error: unknown, raw: string) => {
				console.error(
					`subscribe("${definition.name}"): dropped a message`,
					{ raw },
					error,
				);
			});
		const handler: Handler = (raw) => {
			void (async () => {
				try {
					const result = definition.schema.safeParse(JSON.parse(raw as string));
					if (!result.success) {
						throw new RedisError(
							'INVALID',
							definition.name,
							`A message on "${definition.name}" does not match its schema: ` +
								result.error.issues.map((issue) => issue.message).join('; '),
							{ cause: result.error },
						);
					}
					await deliver(result.data);
				} catch (error) {
					try {
						onError(error, raw as string);
					} catch (fromOnError) {
						console.error(
							`subscribe("${definition.name}"): onError threw`,
							fromOnError,
						);
					}
				}
			})();
		};
		handlers.add(handler);
		return async () => {
			handlers.delete(handler);
		};
	};
	const subscribe = async (
		deliver: (message: never) => void | Promise<void>,
		options?: SubscribeOptions,
	): Promise<Subscription> => {
		const detach = attach(deliver as (message: unknown) => void, options);
		const close = async () => {
			closers.delete(close);
			await detach();
		};
		closers.add(close);
		return {
			channel: definition.name,
			close,
			[Symbol.asyncDispose]: close,
		};
	};
	let streams: KeyedStreams<unknown> | undefined;
	const streamsOf = () => {
		const select = definition.key;
		if (select === undefined) {
			throw new TypeError(
				`channel "${definition.name}": stream() needs a \`key\` in its defineChannel`,
			);
		}
		if (streams !== undefined) return streams;
		const hub = createKeyedStreams<unknown>(
			{
				publish,
				subscribe: async (deliver) => ({ close: attach(deliver) }),
			},
			(message) => select.call(definition, message),
		);
		streams = hub;
		const close = () => {
			closers.delete(close);
			if (streams === hub) streams = undefined;
			return hub.close();
		};
		closers.add(close);
		return hub;
	};
	return {
		definition,
		name: definition.name,
		publish,
		subscribe,
		stream: (key: string, options?: { bufferSize?: number }) =>
			streamsOf().stream(key, options),
		close: async () => {
			await streams?.close();
		},
	};
}

/**
 * Binds channel definitions to a transport inside this process: no Redis, no
 * client, no connection to retry. For a development run, a spec or a
 * single-process app, where `publish` and `stream(key)` should work without
 * a server. Only this process hears a message, and it is not kept.
 *
 * ```ts
 * import * as channels from './channels';
 *
 * const local = localChannels({ channels });
 * for await (const change of local.channels.roomChanged.stream('r1')) {
 * 	console.log(change);
 * }
 * ```
 *
 * A message is checked against the schema when it is published and again
 * when it is delivered, as with Redis; `publish` resolves with the number of
 * subscriptions it reached.
 */
export function localChannels<Ch extends object>(options: {
	channels: Ch;
}): LocalChannels<Ch> {
	const closers = new Set<() => Promise<void>>();
	const bound: Record<string, unknown> = {};
	const entries = Object.entries(options.channels);
	for (const [name, value] of entries) {
		if (!isChannel(value)) continue;
		bound[name] = localChannel(value, closers);
	}
	return {
		channels: Object.freeze(bound) as ChannelScope<Ch>,
		async close() {
			await Promise.all([...closers].map((close) => close()));
		},
	};
}
