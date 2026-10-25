/**
 * Undoes one PNG row filter (spec section 9), in place. `row` holds the
 * filtered bytes of one row, `previous` the unfiltered row above it (all zero
 * for the first row), both `stride` bytes long from `offset`; `bpp` is the
 * bytes per pixel.
 *
 * Returns `false` for a filter type the spec does not define.
 */
export function unfilterRow(
	type: number,
	row: Uint8Array,
	previous: Uint8Array,
	offset: number,
	stride: number,
	bpp: number,
): boolean {
	const end = offset + stride;
	switch (type) {
		case 0:
			return true;
		case 1:
			for (let i = offset + bpp; i < end; i++) {
				row[i] = ((row[i] as number) + (row[i - bpp] as number)) & 0xff;
			}
			return true;
		case 2:
			for (let i = offset; i < end; i++) {
				row[i] = ((row[i] as number) + (previous[i] as number)) & 0xff;
			}
			return true;
		case 3:
			for (let i = offset; i < end; i++) {
				const left = i - bpp >= offset ? (row[i - bpp] as number) : 0;
				row[i] =
					((row[i] as number) + ((left + (previous[i] as number)) >> 1)) & 0xff;
			}
			return true;
		case 4:
			for (let i = offset; i < end; i++) {
				const has = i - bpp >= offset;
				const left = has ? (row[i - bpp] as number) : 0;
				const upLeft = has ? (previous[i - bpp] as number) : 0;
				row[i] =
					((row[i] as number) + paeth(left, previous[i] as number, upLeft)) &
					0xff;
			}
			return true;
		default:
			return false;
	}
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
}
