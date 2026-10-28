/** Messages a slow reader may leave unread before its oldest are dropped. */
export const DEFAULT_BUFFER_SIZE = 256;

/** The part of a channel a keyed stream is built on. */
export interface StreamSource<T> {
	publish(message: T): Promise<unknown>;
	subscribe(
		handler: (message: T) => void,
		options?: { onError?: (error: unknown, raw: string) => void },
	): Promise<{ close(): Promise<void> }>;
	/**
	 * The message as the schema parses it; throws what `publish` throws for a
	 * message the schema refuses. Needed only for the local fallback.
	 */
	parse?(message: T): T;
	/** Whether an error from `publish` is a refusal rather than a transport failure. */
	refuses?(error: unknown): boolean;
}

export interface StreamOptions {
	/**
	 * Messages this iterator may leave unread before the oldest are dropped.
	 * A whole number, at least 1. Default 256.
	 */
	bufferSize?: number;
}

/** What one open iterator registers. */
export interface Listener<T> {
	key: string;
	push(message: T): void;
	stop(): void;
}

/** The state of one channel's streams: data only, the functions take it first. */
export interface StreamContext<T> {
	readonly source: StreamSource<T>;
	readonly keyOf: (message: T) => string;
	/** Deliver a refused `publish` to the local iterators of its key. */
	readonly fallback: boolean;
	/** With `fallback`, a refused `publish` nobody here reads is dropped, not thrown. */
	readonly dropUnread: boolean;
	readonly byKey: Map<string, Set<Listener<T>>>;
	count: number;
	closed: boolean;
	opened: Promise<{ close(): Promise<void> }> | undefined;
	/** The subscription once `opened` has resolved; `undefined` while in flight. */
	live: { close(): Promise<void> } | undefined;
}

export function newContext<T>(
	source: StreamSource<T>,
	keyOf: (message: T) => string,
	fallback: boolean,
	dropUnread = false,
): StreamContext<T> {
	return {
		source,
		keyOf,
		fallback,
		dropUnread,
		byKey: new Map(),
		count: 0,
		closed: false,
		opened: undefined,
		live: undefined,
	};
}
