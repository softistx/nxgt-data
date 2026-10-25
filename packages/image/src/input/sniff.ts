export type SniffedFormat = 'jpeg' | 'png' | 'webp' | 'heic';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Brands of an ISO-BMFF `ftyp` box that mean a HEIF image Bun can decode. */
const HEIC_BRANDS = new Set([
	'heic',
	'heix',
	'heim',
	'heis',
	'hevc',
	'hevx',
	'mif1',
	'msf1',
]);

/** AVIF shares `mif1` with HEIC, so its own brands refuse the file. */
const AVIF_BRANDS = new Set(['avif', 'avis']);

function startsWith(bytes: Uint8Array, signature: number[], at = 0): boolean {
	return (
		bytes.length >= at + signature.length &&
		signature.every((value, i) => bytes[at + i] === value)
	);
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
	return String.fromCharCode(...bytes.subarray(at, at + length));
}

/**
 * The brands of the `ftyp` box at offset 4: the major brand, then every
 * compatible brand the box declares, the box size bounded by the buffer.
 */
function brandsOf(bytes: Uint8Array): string[] {
	if (bytes.length < 12 || ascii(bytes, 4, 4) !== 'ftyp') return [];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const end = Math.min(bytes.length, Math.max(view.getUint32(0), 16));
	const brands = [ascii(bytes, 8, 4)];
	// Skip the major brand (8) and the minor version (12): the rest are 4 bytes each.
	for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(bytes, at, 4));
	return brands;
}

/**
 * The format the first bytes announce, or `undefined`. Magic bytes only: a
 * file name and a declared content type are what the uploader chose. Short or
 * truncated input is `undefined`, never an error. AVIF is refused here, since
 * it is not an accepted input.
 */
export function sniffFormat(bytes: Uint8Array): SniffedFormat | undefined {
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
	if (startsWith(bytes, PNG)) return 'png';
	if (
		bytes.length >= 12 &&
		ascii(bytes, 0, 4) === 'RIFF' &&
		ascii(bytes, 8, 4) === 'WEBP'
	) {
		return 'webp';
	}
	const brands = brandsOf(bytes);
	if (brands.some((brand) => AVIF_BRANDS.has(brand))) return undefined;
	if (brands.some((brand) => HEIC_BRANDS.has(brand))) return 'heic';
	return undefined;
}
