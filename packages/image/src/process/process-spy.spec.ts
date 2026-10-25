import { afterEach, describe, expect, test } from 'bun:test';
import { pattern, writePng } from '../../test/images';
import { scene } from '../../test/scene';
import { defineImageSet } from '../set/define-image-set';

type Method = 'metadata' | 'png' | 'resize';
type Proto = Record<Method, (...args: unknown[]) => unknown>;
const proto = Bun.Image.prototype as unknown as Proto;
const originals = {
	metadata: proto.metadata,
	png: proto.png,
	resize: proto.resize,
};

afterEach(() => {
	for (const method of Object.keys(originals) as Method[]) {
		proto[method] = originals[method];
	}
});

/**
 * Holds `metadata`, or the `bytes()` that ends a `png()` pipeline (`png()`
 * itself only builds the pipeline), until `release()`, counting the calls
 * started.
 */
function gate(method: 'metadata' | 'png') {
	const state = { started: 0, open: false };
	const waiting: (() => void)[] = [];
	const held = <T>(call: () => T): Promise<T> | T => {
		state.started++;
		if (state.open) return call();
		return new Promise<T>((resolve, reject) => {
			waiting.push(() => {
				try {
					resolve(call());
				} catch (error) {
					reject(error);
				}
			});
		});
	};
	if (method === 'metadata') {
		proto.metadata = function (this: unknown, ...args: unknown[]) {
			return held(() => originals.metadata.apply(this, args));
		};
	} else {
		proto.png = function (this: unknown, ...args: unknown[]) {
			const pipeline = originals.png.apply(this, args) as {
				bytes: () => Promise<Uint8Array>;
			};
			const bytes = pipeline.bytes.bind(pipeline);
			pipeline.bytes = () => held(bytes) as Promise<Uint8Array>;
			return pipeline;
		};
	}
	return {
		state,
		release() {
			state.open = true;
			for (const resume of waiting.splice(0)) resume();
		},
	};
}

const settle = () => Bun.sleep(30);

describe('process: the concurrency limit', () => {
	test('at most `concurrency` calls read their size, and then decode, at once', async () => {
		const set = defineImageSet({ sizes: [64, 32], concurrency: 2 });
		const png = writePng(scene());
		const metadata = gate('metadata');
		const encode = gate('png');
		const calls = Array.from({ length: 6 }, () => set.process(png));

		// Six calls, two places: only two have asked for their size.
		await settle();
		expect(metadata.state.started).toBe(2);
		expect(encode.state.started).toBe(0);

		metadata.release();
		await settle();
		// The two in the limit are held at the shrink; the other four still wait,
		// since a place is only free once a call has finished.
		expect(encode.state.started).toBe(2);
		expect(metadata.state.started).toBe(2);

		encode.release();
		const results = await Promise.all(calls);
		expect(results).toHaveLength(6);
		for (const result of results) expect(result.variants).toHaveLength(2);
		expect(metadata.state.started).toBe(6);
	});
});

describe('process: the shrink factor', () => {
	test('shrinks to twice the largest size over the crop, in one resize', async () => {
		const sizes: [number, number][] = [];
		proto.resize = function (this: unknown, ...args: unknown[]) {
			sizes.push([args[0] as number, args[1] as number]);
			return originals.resize.apply(this, args);
		};
		const set = defineImageSet({ sizes: [64, 32] });
		// 1200x600 with a 400 px crop: scale 2 x 64 / 400 = 0.32, so 384 x 192.
		// Always halving would give 600 x 300; the smallest size, 192 x 96.
		await set.process(writePng(pattern(1200, 600, 3)), {
			crop: { x: 100, y: 100, size: 400 },
		});
		// The shrink, then one resize per variant on the cropped square.
		expect(sizes[0]).toEqual([384, 192]);
		expect(sizes.slice(1)).toEqual([
			[64, 64],
			[32, 32],
		]);
	});

	test('a source that is small enough is not resized before the crop', async () => {
		const sizes: [number, number][] = [];
		proto.resize = function (this: unknown, ...args: unknown[]) {
			sizes.push([args[0] as number, args[1] as number]);
			return originals.resize.apply(this, args);
		};
		// 100 px under 2 x 64: scale 1, so the only resizes are the variants.
		await defineImageSet({ sizes: [64, 32] }).process(writePng(scene(1, 1)));
		expect(sizes).toEqual([
			[64, 64],
			[32, 32],
		]);
	});
});
