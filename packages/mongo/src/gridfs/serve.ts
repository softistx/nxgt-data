import type { ByteRange, FileHandle, ResponseInit } from './handle';

/**
 * A `Range` header, read against a known size.
 *
 * Only a single range is honoured. A multipart answer is the other half of
 * the specification, it needs its own body format, and no browser asks for
 * one when playing media — which is what ranges are for here. A request for
 * several is answered with the whole file, which is what the specification
 * allows when a server will not satisfy the range.
 *
 * `end` comes back **exclusive**, because that is how `openDownloadStream`
 * reads it — measured: `{ start: 10, end: 20 }` gives ten bytes.
 */
export function parseRange(
	header: string | null,
	size: number,
): ByteRange | 'unsatisfiable' | undefined {
	if (!header) return undefined;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return undefined;
	const [, from, to] = match;
	if (from === '' && to === '') return undefined;
	if (from === '') {
		// `bytes=-500`: the last 500 bytes, and the whole file when it is
		// shorter than that.
		const wanted = Number(to);
		// A file of no bytes has no last 500 of them — and `bytes=0-` on the
		// same file is already unsatisfiable below, so anything else would have
		// the two branches disagree.
		if (wanted === 0 || size === 0) return 'unsatisfiable';
		return { start: Math.max(0, size - wanted), end: size };
	}
	const start = Number(from);
	if (start >= size) return 'unsatisfiable';
	const end = to === '' ? size : Math.min(size, Number(to) + 1);
	if (end <= start) return 'unsatisfiable';
	return { start, end };
}

/**
 * The response for this request: the whole file, the range it asked for, or
 * `416` when the range cannot be satisfied.
 *
 * ```ts
 * app.get('/files/:id', async (c) =>
 * 	(await files.get(c.req.param('id'))).serve(c.req.raw),
 * );
 * ```
 */
export function serveFile(
	file: FileHandle,
	request: Request,
	init: ResponseInit = {},
): Response {
	// A conditional request that already has the bytes: nothing to send.
	const etag = file.sha256 ? `"${file.sha256}"` : undefined;
	// The caller's own headers belong on every answer, not only on the two
	// that carry a body: a `Cache-Control` a handler sets is most wanted on
	// exactly the `304` a caching client gets back.
	if (etag && matchesEtag(request.headers.get('if-none-match'), etag)) {
		const headers = new Headers(init.headers);
		headers.set('etag', etag);
		headers.set('accept-ranges', 'bytes');
		return new Response(null, { status: 304, headers });
	}
	const range = parseRange(request.headers.get('range'), file.size);
	if (range === 'unsatisfiable') {
		const headers = new Headers(init.headers);
		headers.set('content-range', `bytes */${file.size}`);
		headers.set('accept-ranges', 'bytes');
		return new Response(null, { status: 416, headers });
	}
	return file.response({ ...init, ...(range ? { range } : {}) });
}

/** `If-None-Match`, including the `W/` form and a bare `*`. */
function matchesEtag(header: string | null, etag: string): boolean {
	if (!header) return false;
	return header
		.split(',')
		.map((one) => one.trim().replace(/^W\//, ''))
		.some((one) => one === '*' || one === etag);
}
