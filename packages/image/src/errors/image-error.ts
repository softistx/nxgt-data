/**
 * What went wrong. Each one is in the README's Errors table, and each
 * message it carries has an entry in `docs/troubleshooting.md`, headed by its
 * text.
 */
export type ImageErrorCode =
	/** The upload is bigger than the byte or pixel limit. */
	| 'TOO_LARGE'
	/**
	 * The bytes are not a JPEG, PNG, WebP or HEIC, judged by their first bytes
	 * and never by a file name or a declared content type — or a HEIC this
	 * machine cannot decode.
	 */
	| 'UNSUPPORTED_TYPE'
	/** The bytes look like an accepted format but cannot be decoded. */
	| 'UNDECODABLE'
	/** The image is smaller than the smallest side the caller asked for. */
	| 'TOO_SMALL'
	/**
	 * The `crop` the caller sent is not three whole numbers of 0 or more, or
	 * does not fit the image. It can come from a request, so it is a refusal
	 * to answer with a 4xx, not a bug to answer with a 500.
	 */
	| 'INVALID_CROP';

/**
 * Why a refusal happened, for a caller that answers differently per cause.
 *
 * - `bytes`: the upload is over the byte limit.
 * - `pixels`: the image claims more pixels than the limit.
 * - `format`: the first bytes match no accepted format, or this machine
 *   cannot decode the format they announce.
 * - `heic-unavailable`: a HEIC, on a machine whose Bun cannot decode one
 *   (Linux; HEIC decodes on macOS and Windows only).
 * - `decode`: the format is right and the content is damaged or unsupported.
 * - `dimensions`: the image is under the smallest side asked for.
 * - `crop`: the crop is badly shaped, or does not fit the image.
 */
export type ImageErrorReason =
	| 'bytes'
	| 'pixels'
	| 'format'
	| 'heic-unavailable'
	| 'decode'
	| 'dimensions'
	| 'crop';

/**
 * This package's error class for refusals. Every one of them is thrown
 * before anything is stored. A message names the cause and the limit, never
 * the uploaded bytes.
 */
export class ImageError extends Error {
	readonly code: ImageErrorCode;
	readonly reason: ImageErrorReason;

	constructor(
		code: ImageErrorCode,
		reason: ImageErrorReason,
		message?: string,
	) {
		super(message ?? `${code}: ${reason}`);
		this.name = 'ImageError';
		this.code = code;
		this.reason = reason;
	}
}
