import { describe, expect, test } from 'bun:test';
import { pattern, writePng } from '../../test/images';
import {
	pngWithMetadata,
	webpChunks,
	withExif,
	withIcc,
} from '../../test/metadata';
import { defineImageSet } from '../set/define-image-set';

const set = defineImageSet({ sizes: [64, 32] });
const FORBIDDEN = ['ICCP', 'EXIF', 'XMP '];
const source = writePng(pattern(160, 120, 3));

async function chunksOfEach(input: Uint8Array): Promise<string[][]> {
	const { variants } = await set.process(input);
	return variants.map((variant) => webpChunks(variant.bytes));
}

function expectStripped(all: string[][]) {
	expect(all).toHaveLength(2);
	for (const chunks of all) {
		expect(chunks.length).toBeGreaterThan(0);
		for (const name of FORBIDDEN) expect(chunks).not.toContain(name);
	}
}

describe('process: metadata is stripped', () => {
	test('a JPEG with an EXIF segment holding GPS tags', async () => {
		const jpeg = await new Bun.Image(source).jpeg().bytes();
		const input = withExif(jpeg, { orientation: 1, gps: true });
		// The segment is really there: Bun reads the orientation from it.
		expect(input.length).toBeGreaterThan(jpeg.length + 60);
		expectStripped(await chunksOfEach(input));
	});

	test('a PNG with iCCP and eXIf chunks', async () => {
		const input = pngWithMetadata(source);
		// The control: Bun alone carries the profile into its WebP.
		const direct = await new Bun.Image(input).webp().bytes();
		expect(webpChunks(direct)).toContain('ICCP');
		expectStripped(await chunksOfEach(input));
	});

	test('a JPEG with an ICC profile in APP2', async () => {
		const jpeg = await new Bun.Image(source).jpeg().bytes();
		const input = withIcc(jpeg);
		const direct = await new Bun.Image(input).webp().bytes();
		expect(webpChunks(direct)).toContain('ICCP');
		expectStripped(await chunksOfEach(input));
	});
});
