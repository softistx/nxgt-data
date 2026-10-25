import { describe, expect, test } from 'bun:test';
import { rejection } from '../../test/rejection';
import { ImageError } from '../errors/image-error';
import { readInput } from './read-input';

const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function stream(chunks: Uint8Array[]) {
	const state = { pulled: 0, cancelled: false };
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				const next = chunks[state.pulled++];
				if (next) controller.enqueue(next);
				else controller.close();
			},
			cancel() {
				state.cancelled = true;
			},
		},
		{ highWaterMark: 0 },
	);
	return { body, state };
}

async function tooLarge(promise: Promise<unknown>) {
	const error = await rejection(promise);
	expect(error).toBeInstanceOf(ImageError);
	expect((error as ImageError).code).toBe('TOO_LARGE');
	expect((error as ImageError).reason).toBe('bytes');
}

describe('readInput', () => {
	test('reads each input type', async () => {
		expect(await readInput(bytes, 8)).toEqual(bytes);
		expect(await readInput(bytes.buffer.slice(0) as ArrayBuffer, 8)).toEqual(
			bytes,
		);
		expect(await readInput(new Blob([bytes]), 8)).toEqual(bytes);
		const { body } = stream([bytes.subarray(0, 3), bytes.subarray(3)]);
		expect(await readInput(body, 8)).toEqual(bytes);
	});

	test('refuses over the cap and accepts exactly the cap', async () => {
		await tooLarge(readInput(bytes, 7));
		await tooLarge(readInput(bytes.buffer.slice(0) as ArrayBuffer, 7));
		await tooLarge(readInput(new Blob([bytes]), 7));
		await tooLarge(readInput(stream([bytes]).body, 7));
		expect((await readInput(stream([bytes]).body, 8)).length).toBe(8);
	});

	test('cancels a stream at the chunk that crosses the cap, without draining it', async () => {
		const chunks = Array.from({ length: 100 }, () => new Uint8Array(10));
		const { body, state } = stream(chunks);
		await tooLarge(readInput(body, 25));
		expect(state.cancelled).toBe(true);
		expect(state.pulled).toBeLessThanOrEqual(4);
	});

	test('refuses an input of another type with a TypeError', async () => {
		const error = await rejection(readInput('a path' as never, 8));
		expect(error).toBeInstanceOf(TypeError);
	});
});
