import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSeaweedfs } from './seaweedfs';

/** Runs `fn` with `$WEED_BIN` set, and puts the environment back. */
async function withBin(value: string, fn: () => Promise<void>): Promise<void> {
	const before = process.env.WEED_BIN;
	process.env.WEED_BIN = value;
	try {
		await fn();
	} finally {
		if (before === undefined) delete process.env.WEED_BIN;
		else process.env.WEED_BIN = before;
	}
}

describe('scripts/seaweedfs.ts', () => {
	test('uses $WEED_BIN when it names one that exists', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'weed-bin-'));
		const binary = join(dir, 'weed');
		try {
			await Bun.write(binary, '#!/bin/sh\necho version 4.47\n');
			await withBin(binary, async () => {
				expect(await ensureSeaweedfs()).toBe(binary);
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('says so when WEED_BIN points at nothing', async () => {
		await withBin('/nowhere/weed', async () => {
			await expect(ensureSeaweedfs()).rejects.toThrow('which does not exist');
		});
	});
});
