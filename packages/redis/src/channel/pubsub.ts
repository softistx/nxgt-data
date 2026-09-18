import type { RedisClient } from 'bun';
import type { z } from 'zod';
import { RedisError } from '../errors/redis-error';
import type { ChannelDefinition } from './define-channel';

/** A running subscription. Closing it gives back the connection it took. */
export interface Subscription extends AsyncDisposable {
	readonly channel: string;
	/** Idempotent. */
	close(): Promise<void>;
}

export interface SubscribeOptions {
	/**
	 * What to do with a message that does not match the schema, or with an
	 * error a handler throws. It is called instead of the handler, never
	 * beside it. The default writes to `console.error`: a listener's throw
	 * has nowhere to go, and dropping it silently is worse.
	 */
	onError?: (error: unknown, raw: string) => void;
}

/**
 * Publishes a message, checked against the channel's schema first.
 *
 * Gives back the number of subscribers Redis handed it to — **not** a
 * delivery guarantee: Redis pub/sub is fire-and-forget, and a subscriber that
 * is not connected at this instant never sees the message.
 */
export async function publish<S extends z.ZodType>(
	client: RedisClient,
	channel: ChannelDefinition<S>,
	payload: z.output<S>,
): Promise<number> {
	const result = channel.schema.safeParse(payload);
	if (!result.success) {
		throw new RedisError(
			'INVALID',
			channel.name,
			`This message does not match the schema "${channel.name}" carries: ` +
				result.error.issues.map((issue) => issue.message).join('; '),
			{ cause: result.error },
		);
	}
	return await client.publish(channel.name, JSON.stringify(result.data));
}

/**
 * Listens to a channel, with each message parsed by its schema.
 *
 * ```ts
 * await using running = await subscribe(redis.client, userCreated, (user) => {
 * 	console.log('welcome', user.email);
 * });
 * ```
 *
 * A subscriber connection can run no other command, which is Redis's own
 * rule, so this **duplicates** the client and holds the copy. `close()` gives
 * that copy back; the client passed in is untouched, and is still the one to
 * `publish` with.
 */
export async function subscribe<S extends z.ZodType>(
	client: RedisClient,
	channel: ChannelDefinition<S>,
	handler: (payload: z.output<S>) => void | Promise<void>,
	options: SubscribeOptions = {},
): Promise<Subscription> {
	const onError =
		options.onError ??
		((error: unknown, raw: string) => {
			console.error(
				`subscribe("${channel.name}"): dropped a message`,
				{ raw },
				error,
			);
		});

	const subscriber = await client.duplicate();
	await subscriber.connect();

	await subscriber.subscribe(channel.name, (raw: string) => {
		void (async () => {
			try {
				const result = channel.schema.safeParse(JSON.parse(raw));
				if (!result.success) {
					throw new RedisError(
						'INVALID',
						channel.name,
						`A message on "${channel.name}" does not match its schema: ` +
							result.error.issues.map((issue) => issue.message).join('; '),
						{ cause: result.error },
					);
				}
				await handler(result.data as z.output<S>);
			} catch (error) {
				// A listener's throw has nowhere to go: Bun would see an
				// unhandled rejection and end the process.
				try {
					onError(error, raw);
				} catch (fromOnError) {
					// The last resort must not be able to throw either — a
					// logger with a dead transport would otherwise end the
					// process through the very handler that exists to stop that.
					console.error(
						`subscribe("${channel.name}"): onError threw`,
						fromOnError,
					);
				}
			}
		})();
	});

	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= (async () => {
			// Giving the connection back is the part that must always happen:
			// were `unsubscribe` to reject — a server that went away mid
			// shutdown — the duplicate would leak, and `closing` would hold
			// that rejection for every later call, so nobody could retry.
			try {
				await subscriber.unsubscribe(channel.name);
			} finally {
				subscriber.close();
			}
		})();
		return closing;
	};

	return { channel: channel.name, close, [Symbol.asyncDispose]: close };
}
