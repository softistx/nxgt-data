import type { ImageErrorCode, ImageErrorReason } from '../errors/image-error';
import { ImageError } from '../errors/image-error';
import type { SniffedFormat } from '../input/sniff';

function refusal(
	code: ImageErrorCode,
	reason: ImageErrorReason,
	message: string,
	cause: unknown,
): ImageError {
	const error = new ImageError(code, reason, message);
	error.cause = cause;
	return error;
}

/**
 * Bun's `error.code` on a `Bun.Image` rejection, as this package's
 * `ImageError`; any other error comes back untouched, so a bug or an
 * out-of-memory is never taken for a bad upload. Bun's error is the `cause`.
 */
export function mapBunError(error: unknown, format: SniffedFormat): unknown {
	const code = (error as { code?: unknown } | null)?.code;
	switch (code) {
		case 'ERR_IMAGE_TOO_MANY_PIXELS':
			return refusal(
				'TOO_LARGE',
				'pixels',
				'the image has too many pixels',
				error,
			);
		case 'ERR_IMAGE_FORMAT_UNSUPPORTED':
			return format === 'heic'
				? refusal(
						'UNSUPPORTED_TYPE',
						'heic-unavailable',
						'this machine cannot decode HEIC (Linux cannot)',
						error,
					)
				: refusal(
						'UNSUPPORTED_TYPE',
						'format',
						`this machine cannot decode ${format}`,
						error,
					);
		case 'ERR_IMAGE_DECODE_FAILED':
		case 'ERR_IMAGE_UNKNOWN_FORMAT':
			return refusal(
				'UNDECODABLE',
				'decode',
				`the ${format} image cannot be decoded`,
				error,
			);
		default:
			return error;
	}
}
