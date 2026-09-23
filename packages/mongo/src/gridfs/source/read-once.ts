/**
 * The sources that can be read only once, and the refusal of one that was.
 *
 * A transaction the driver retries runs its callback again, over the source
 * the first run read — measured with `autoSync` on mongod 8.2.6, whose first
 * upload in a transaction fails its commit with 112 — and a spent source
 * reads as empty. Read as it was, that stored a file of 0 bytes, with no
 * error, beside what the callback committed.
 *
 * Everything here checks on the **first pull**, never when the source is
 * handed over: a call refused before it reads a byte — an `_id` already
 * taken — leaves the source as it found it, for the call after it.
 */

/** A source with nothing left to give: a shape, never a value. */
export function spent(where: string): TypeError {
	return new TypeError(
		`${where}: this stream was already read, or is held by another reader, ` +
			'so it has nothing left to store. A transaction the driver retries ' +
			'runs this call again over the stream its first run read. Read it ' +
			'into bytes before the transaction, or pass a Blob or a `Bun.file`.',
	);
}

/**
 * A web stream, read piece by piece.
 *
 * Taken through `new Response(stream)`, which is Fetch's own rule: a body
 * that is disturbed or locked is a `TypeError`. `locked` alone cannot tell —
 * measured on bun 1.4.2, a drained stream whose reader was released answers
 * `false`. The bytes come from the response's body, not the stream: bun
 * hands a `Blob`'s stream over to the response and locks it.
 *
 * `for await (… of stream)` works in bun and in node, and the DOM lib does
 * not declare it, so the reader is spelled out rather than cast away.
 */
export async function* pieces(
	stream: ReadableStream<Uint8Array>,
	where: string,
): AsyncIterable<Uint8Array> {
	let body: ReadableStream<Uint8Array> | null;
	try {
		body = new Response(stream).body as ReadableStream<Uint8Array> | null;
	} catch {
		throw spent(where);
	}
	if (!body) return;
	const reader = body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			if (value) yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Iterators this package started reading. A generator is its own iterator,
 * answers `done` at once when read again, and says nowhere that it was read.
 */
const started = new WeakSet<object>();

/**
 * A node `Readable` that says it was read.
 *
 * Measured on bun 1.4.2: `readableDidRead` is true after a single `read(1)`,
 * and `destroyed` alone after `destroy()` on a stream nobody read — which
 * would otherwise fail with `Premature close` rather than this refusal.
 * `readableEnded` alone comes from a stream that ended while flowing with
 * nothing read — `autoDestroy: false`, `push(null)`, `resume()` — whose
 * iteration then gives no bytes at all.
 */
function nodeSpent(source: object): boolean {
	const node = source as Record<string, unknown>;
	return (
		node.readableDidRead === true ||
		node.readableEnded === true ||
		node.destroyed === true
	);
}

/**
 * An async iterable, refused when it can be read once and was: a node
 * `Readable` that says so, or an iterator read here before.
 *
 * Its iterator is asked for once, and remembered only when it is the source
 * itself, as a generator's is. An iterable that hands out a new iterator each
 * time is not spent by being read — even one that also has a `next` — and is
 * read again. One whose new iterators all read the same one-shot resource
 * cannot be told apart from it, and is stored as whatever is left.
 */
export async function* once(
	source: AsyncIterable<Uint8Array>,
	where: string,
): AsyncIterable<Uint8Array> {
	if (nodeSpent(source)) throw spent(where);
	const iterator = source[Symbol.asyncIterator]();
	if ((iterator as unknown) === source) {
		if (started.has(iterator)) throw spent(where);
		started.add(iterator);
	}
	yield* { [Symbol.asyncIterator]: () => iterator };
}
