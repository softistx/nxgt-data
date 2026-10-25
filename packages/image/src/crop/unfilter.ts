/**
 * PNG row filters (spec section 9), undone in place. `raw` holds each row as
 * one filter-type byte then `stride` bytes; the result is the rows without
 * their filter bytes, `bpp` being the bytes per pixel.
 *
 * Returns `false` for a filter byte the spec does not define.
 */
export function unfilter(
	raw: Uint8Array,
	width: number,
	height: number,
	bpp: number,
): Uint8Array | false {
	const stride = width * bpp;
	const out = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const type = raw[y * (stride + 1)];
		const src = y * (stride + 1) + 1;
		const row = y * stride;
		const above = row - stride;
		for (let i = 0; i < stride; i++) {
			const x = raw[src + i] as number;
			const left = i >= bpp ? (out[row + i - bpp] as number) : 0;
			const up = y > 0 ? (out[above + i] as number) : 0;
			const upLeft = y > 0 && i >= bpp ? (out[above + i - bpp] as number) : 0;
			let predicted: number;
			switch (type) {
				case 0:
					predicted = 0;
					break;
				case 1:
					predicted = left;
					break;
				case 2:
					predicted = up;
					break;
				case 3:
					predicted = (left + up) >> 1;
					break;
				case 4:
					predicted = paeth(left, up, upLeft);
					break;
				default:
					return false;
			}
			out[row + i] = (x + predicted) & 0xff;
		}
	}
	return out;
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
}
