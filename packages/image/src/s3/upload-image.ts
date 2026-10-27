import { cropFromQuery } from '../crop/from-query';
import { ImageError } from '../errors/image-error';
import type { ImageStore, StoredImage } from './types';

/**
 * Stores the image a request uploads, under a fresh id.
 *
 * - The request's `content-type` must be `image/*` (any case, parameters
 *   ignored); otherwise `ImageError` `UNSUPPORTED_TYPE` / `format`, before the
 *   body is read. The bytes themselves are still judged by their magic bytes.
 * - The body is streamed into `store.replace`, so a body over the set's byte
 *   limit is an `ImageError` `TOO_LARGE` / `bytes` and is cancelled at the
 *   chunk that crosses it.
 * - The optional crop comes from `?x=&y=&size=` (see `cropFromQuery`); a
 *   bad one is `INVALID_CROP`.
 *
 * `owner` is the store's params without `imageId`; the id is
 * `crypto.randomUUID()` and is returned, to be saved beside `version`.
 */
export async function uploadImage<P extends { imageId: string }>(
	store: Pick<ImageStore<P>, 'replace'>,
	owner: Omit<P, 'imageId'>,
	request: Request,
): Promise<{ id: string } & StoredImage> {
	const type = request.headers.get('content-type') ?? '';
	if (!/^\s*image\//i.test(type)) {
		throw new ImageError(
			'UNSUPPORTED_TYPE',
			'format',
			'the request is not an image: its content-type must be image/*',
		);
	}
	const id = crypto.randomUUID();
	const crop = cropFromQuery(new URL(request.url).searchParams);
	const stored = await store.replace(
		{ ...owner, imageId: id } as P,
		request.body ?? new Uint8Array(0),
		crop ? { crop } : undefined,
	);
	return { id, version: stored.version, variants: stored.variants };
}
