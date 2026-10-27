import { expect, test } from 'bun:test';
import { freePorts, releasePorts } from './ports';

test('blocks picked at the same time never share a port', async () => {
	// Without a claim, 200 blocks of 8 in a 10 000-wide range overlap about
	// thirty times over, so this fails on the old code every run.
	const blocks = await Promise.all(Array.from({ length: 200 }, freePorts));
	try {
		const all = blocks.flat();
		expect(new Set(all).size).toBe(all.length);
	} finally {
		for (const block of blocks) releasePorts(block);
	}
});
