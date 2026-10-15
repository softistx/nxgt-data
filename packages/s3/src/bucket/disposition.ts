import { S3Error } from '../errors/s3-error';
import { shapeOf } from './shape';

/** Printable ASCII, space to tilde: no CR, LF, NUL, tab or other control. */
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

/**
 * Refuses a `contentDisposition` that could not be one header value: a
 * non-empty string of printable ASCII. A line break in it would split the
 * header it ends up in, and RFC 6266 spells a non-ASCII filename as
 * `filename*=UTF-8''...`, percent-encoded, so ASCII loses nothing. The value
 * is reported by its shape, never quoted: it may have come off a request.
 */
export function checkDisposition(
	key: string,
	value: unknown,
	where: string,
): void {
	if (typeof value === 'string' && PRINTABLE_ASCII.test(value)) return;
	throw new S3Error(
		'WRONG_OPTION',
		key,
		'contentDisposition must be a non-empty string of printable ASCII, ' +
			'with no line break or control character (spell a non-ASCII filename ' +
			`as filename*=UTF-8''...); got ${
				typeof value === 'string'
					? 'a string with other characters'
					: shapeOf(value)
			} (${where})`,
	);
}
