import { createHash } from 'node:crypto';
import { once, pieces, spent } from './read-once';
/**
 * What a write may be given.
 *
 * `Bun.file(path)`, a `File` and a `Blob` are all `Blob`s — measured on bun
 * 1.4.2, `Bun.file('a.png') instanceof Blob` is `true` — so one branch reads
 * all three, and each of them knows its own size and type.
 */
export type FileSource =
	| Blob
	| Response
	| ReadableStream<Uint8Array>
	| ArrayBuffer
	| ArrayBufferView
	| string
	| AsyncIterable<Uint8Array>;

/** A source, read down to what a write needs and what it told us about itself. */
export interface ReadSource {
	/**
	 * The bytes, in whatever pieces the source gives them. The write cuts
	 * them into chunks of its own size; nothing here has to.
	 */
	chunks: AsyncIterable<Uint8Array>;
	/** The type the source carries, or `undefined` when it carries none. */
	type: string | undefined;
	/** The name the source carries: a `File`'s, or a `Bun.file`'s basename. */
	filename: string | undefined;
	/** The size when it is known before reading, and `undefined` otherwise. */
	size: number | undefined;
}

/**
 * A type the source knows about itself, or nothing.
 *
 * An empty string is what a `Blob` with no type reports — measured — and it
 * has to read as "no type" rather than as a type that is the empty string.
 */
function typeOf(value: string | null | undefined): string | undefined {
	const type = value?.trim();
	return type ? type : undefined;
}

/**
 * The name a source carries.
 *
 * `Bun.file('/tmp/a.png').name` is the whole path — measured — and a stored
 * filename is a name, not a path: a bucket that kept the path would leak the
 * machine's layout into every download.
 */
function nameOf(source: Blob): string | undefined {
	const named = (source as { name?: unknown }).name;
	if (typeof named !== 'string' || named === '') return undefined;
	const tail = named.split('/').pop();
	return tail === '' ? undefined : tail;
}

/** One piece, for a source that is already whole in memory. */
async function* one(bytes: Uint8Array): AsyncIterable<Uint8Array> {
	yield bytes;
}

/**
 * What a source that is none of the shapes turned out to be, for a message:
 * its kind or its class, never its value — and with the article it needs.
 *
 * The class is read off the **prototype**, and only when it is a function:
 * an object's own `constructor` is data, and `JSON.parse` of a request body
 * can put anything there, a secret included, or a getter that throws.
 */
function shapeOf(value: unknown): string {
	if (value === null || value === undefined) return String(value);
	if (Array.isArray(value)) return 'an array';
	let named = '';
	if (typeof value === 'object') {
		try {
			const ctor: unknown = Object.getPrototypeOf(value)?.constructor;
			named = typeof ctor === 'function' ? ctor.name : '';
		} catch {
			// A prototype's `constructor` getter threw. (A proxy whose
			// `getPrototypeOf` throws never gets here: `readSource`'s
			// `instanceof` checks ask it first.)
		}
	}
	const kind = named && named !== 'Object' ? named : typeof value;
	return `${/^[aeiou]/i.test(kind) ? 'an' : 'a'} ${kind}`;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
	return (
		typeof value === 'object' &&
		value !== null &&
		Symbol.asyncIterator in (value as object)
	);
}

/**
 * Reads a source down to the stream GridFS wants, and what it already knew.
 * `where` names the call and the bucket a refusal is on: `put on "uploads"`.
 */
export function readSource(source: FileSource, where = 'put'): ReadSource {
	if (typeof source === 'string') {
		const bytes = new TextEncoder().encode(source);
		return {
			chunks: one(bytes),
			type: undefined,
			filename: undefined,
			// In bytes, never in characters: one emoji is four of them.
			size: bytes.byteLength,
		};
	}
	if (source instanceof Blob) {
		return {
			chunks: pieces(source.stream(), where),
			type: typeOf(source.type),
			filename: nameOf(source),
			// A `Bun.file` that is not there reports a size, and fails when it
			// is read: the size is a claim, and the write is what settles it.
			size: Number.isFinite(source.size) ? source.size : undefined,
		};
	}
	if (source instanceof Response) {
		// A body read before is what a transaction's second run hands over.
		if (source.bodyUsed) throw spent(where);
		const body = source.body;
		if (!body) {
			throw new TypeError(
				`${where}: this Response has no body, so it has nothing to store.`,
			);
		}
		const length = Number(source.headers.get('content-length'));
		return {
			chunks: pieces(body, where),
			type: typeOf(source.headers.get('content-type')),
			filename: undefined,
			size: Number.isFinite(length) && length >= 0 ? length : undefined,
		};
	}
	if (source instanceof ArrayBuffer) {
		return {
			chunks: one(new Uint8Array(source)),
			type: undefined,
			filename: undefined,
			size: source.byteLength,
		};
	}
	if (ArrayBuffer.isView(source)) {
		const view = new Uint8Array(
			source.buffer,
			source.byteOffset,
			source.byteLength,
		);
		return {
			chunks: one(view),
			type: undefined,
			filename: undefined,
			size: source.byteLength,
		};
	}
	if (source instanceof ReadableStream) {
		return {
			chunks: pieces(source, where),
			type: undefined,
			filename: undefined,
			size: undefined,
		};
	}
	if (isAsyncIterable(source)) {
		return {
			chunks: once(source, where),
			type: undefined,
			filename: undefined,
			size: undefined,
		};
	}
	throw new TypeError(
		`${where}: expected a file, a blob, a response, a stream or bytes, not ${shapeOf(source)}`,
	);
}

/**
 * The sha256 of a `Blob`, read without keeping it.
 *
 * A `Blob` — `Bun.file` included — can be streamed more than once, which is
 * what lets `putOnce` know what it is holding before it uploads anything.
 */
export async function digestOf(blob: Blob): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of blob.stream()) hash.update(chunk);
	return hash.digest('hex');
}
