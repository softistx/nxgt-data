import type { ObjectId } from 'mongodb';
import { readChunks } from './chunks';
import type { BucketContext } from './context';
import type { MetadataOf } from './types';

/** Where the type and the digest live: GridFS keeps no field for either. */
export const TYPE_KEY = 'contentType';
export const HASH_KEY = 'sha256';

/** The `<bucket>.files` document, as MongoDB stores it. */
export interface StoredFile {
	_id: ObjectId;
	length: number;
	chunkSize: number;
	uploadDate: Date;
	filename: string;
	metadata?: Record<string, unknown>;
}

/** A half-open byte range, `end` exclusive — as `openDownloadStream` reads it. */
export interface ByteRange {
	start?: number;
	end?: number;
}

export interface ResponseInit {
	/**
	 * Answers `Content-Disposition`. `true` uses the stored filename, a string
	 * uses that name instead.
	 */
	download?: boolean | string;
	/** Added to the response, and never allowed to overwrite the body's own. */
	headers?: HeadersInit;
	status?: number;
}

/**
 * A file that has been **found**, not read.
 *
 * Everything on it but the bodies comes from the one `files` document that
 * finding it already cost: the size, the type, the digest and the metadata
 * are there before a single chunk is fetched. `stream`, `bytes`, `text`,
 * `json`, `blob` and `response` are what actually read.
 */
export class FileHandle<Def = unknown> {
	constructor(
		private readonly ctx: BucketContext,
		/** The `files` document, as stored. */
		readonly stored: StoredFile,
	) {}

	get _id(): ObjectId {
		return this.stored._id;
	}
	/** The id as 24 hex characters, for a URL or a JSON body. */
	get id(): string {
		return this.stored._id.toHexString();
	}
	get filename(): string {
		return this.stored.filename;
	}
	/** The size in bytes. `size` and `length` are the same number. */
	get size(): number {
		return this.stored.length;
	}
	get length(): number {
		return this.stored.length;
	}
	get chunkSize(): number {
		return this.stored.chunkSize;
	}
	get uploadDate(): Date {
		return this.stored.uploadDate;
	}
	/** What the upload carried, or `undefined` when nothing did. */
	get type(): string | undefined {
		const type = this.stored.metadata?.[TYPE_KEY];
		return typeof type === 'string' ? type : undefined;
	}
	/** The SHA-256 of the bytes, when the bucket hashes. */
	get sha256(): string | undefined {
		const hash = this.stored.metadata?.[HASH_KEY];
		return typeof hash === 'string' ? hash : undefined;
	}
	/** The metadata the schema describes — without the two fields above. */
	get metadata(): MetadataOf<Def> {
		const {
			[TYPE_KEY]: _t,
			[HASH_KEY]: _h,
			...rest
		} = this.stored.metadata ?? {};
		return rest as MetadataOf<Def>;
	}

	/** The bytes, as a web stream. A range reads only the chunks it spans. */
	stream(range?: ByteRange): ReadableStream<Uint8Array> {
		return readChunks(
			this.ctx,
			this.stored._id,
			this.stored.chunkSize,
			this.stored.length,
			range,
		);
	}

	async bytes(range?: ByteRange): Promise<Uint8Array> {
		return new Uint8Array(await new Response(this.stream(range)).arrayBuffer());
	}
	async text(range?: ByteRange): Promise<string> {
		return await new Response(this.stream(range)).text();
	}
	async json<T = unknown>(): Promise<T> {
		return (await new Response(this.stream()).json()) as T;
	}
	/** A `Blob` carrying the stored type, so it can be handed straight on. */
	async blob(range?: ByteRange): Promise<Blob> {
		const bytes = await this.bytes(range);
		return new Blob([bytes as BlobPart], { type: this.type ?? '' });
	}

	/**
	 * A response that serves the whole file, or the range asked for.
	 *
	 * `Content-Length` is the number of bytes this response will carry, which
	 * for a range is the range's own length — `end` is exclusive, as
	 * `openDownloadStream` reads it.
	 */
	response(init: ResponseInit & { range?: ByteRange } = {}): Response {
		const headers = new Headers(init.headers);
		const wanted = init.range ? satisfiable(init.range, this.size) : undefined;
		if (init.range && !wanted) {
			// A range naming bytes this file does not have. Serving it as a
			// `206` produces `content-range: bytes 200-69/70` and a body of
			// nothing — a header no client can read. `416` is the answer the
			// specification has for exactly this.
			headers.set('content-range', `bytes */${this.size}`);
			headers.set('accept-ranges', 'bytes');
			return new Response(null, { status: 416, headers });
		}
		const start = wanted?.start ?? 0;
		const end = wanted?.end ?? this.size;
		const partial = wanted !== undefined && (start > 0 || end < this.size);
		if (this.type) headers.set('content-type', this.type);
		headers.set('content-length', String(end - start));
		headers.set('accept-ranges', 'bytes');
		if (this.sha256) headers.set('etag', `"${this.sha256}"`);
		headers.set('last-modified', this.uploadDate.toUTCString());
		if (partial) {
			headers.set('content-range', `bytes ${start}-${end - 1}/${this.size}`);
		}
		if (init.download) {
			const name =
				typeof init.download === 'string' ? init.download : this.filename;
			headers.set('content-disposition', disposition(name));
		}
		return new Response(this.stream(wanted), {
			status: init.status ?? (partial ? 206 : 200),
			headers,
		});
	}
}

/**
 * The range as bytes this file actually has, or nothing when it has none of
 * them.
 *
 * `serveFile` never hands over an impossible range, because `parseRange`
 * guards it — but `response({ range })` is public and takes whatever it is
 * given, so it is checked here rather than trusted.
 */
function satisfiable(range: ByteRange, size: number): ByteRange | undefined {
	const start = range.start ?? 0;
	const end = Math.min(range.end ?? size, size);
	if (start < 0 || start >= size || end <= start) return undefined;
	return { start, end };
}

/**
 * `Content-Disposition`, with the filename given twice.
 *
 * The bare `filename=` is ASCII only and every client understands it;
 * `filename*=` carries the real one, and the clients that understand it
 * prefer it. A quote or a backslash in the name would end the quoted string
 * early, so the ASCII form drops everything that is not plainly safe.
 */
function disposition(name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
