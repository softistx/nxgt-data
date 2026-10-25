import { refuse } from './png-chunks';
import { unfilterRow } from './unfilter';

/**
 * Turns inflated bytes, in chunks of any size, into unfiltered rows. It holds
 * the row above and the row being filled (`stride + 1` bytes each, the filter
 * byte first) and nothing else.
 *
 * `feed(part)` calls `onRow(row, y)` for each finished row, `row` being the
 * buffer with the filter byte at 0 and the pixels from 1; the buffer is
 * reused, so `onRow` copies what it keeps. `onRow` returns `false` to stop:
 * `feed` then returns `false` too and reads no further. A refusal is thrown as
 * an `ImageError`: an unknown filter, or more rows than the header promises.
 */
export function createRowAssembler(
	stride: number,
	height: number,
	bpp: number,
	onRow: (row: Uint8Array, y: number) => boolean,
) {
	let previous = new Uint8Array(stride + 1);
	let current = new Uint8Array(stride + 1);
	let filled = 0;
	let y = 0;

	return {
		/** The rows finished so far. */
		get rows() {
			return y;
		},
		feed(part: Uint8Array): boolean {
			let at = 0;
			while (at < part.length) {
				if (y >= height) {
					throw refuse('the pixel data is longer than the header says');
				}
				const take = Math.min(part.length - at, stride + 1 - filled);
				current.set(part.subarray(at, at + take), filled);
				filled += take;
				at += take;
				if (filled < stride + 1) continue;
				if (
					!unfilterRow(current[0] as number, current, previous, 1, stride, bpp)
				) {
					throw refuse('a row has an unknown filter');
				}
				const more = onRow(current, y);
				[previous, current] = [current, previous];
				filled = 0;
				y++;
				if (!more) return false;
			}
			return true;
		},
	};
}
