import { describe, expect, test } from 'bun:test';
import { eventually } from '../../../test/fixtures';
import type { WorkerContext } from './context';
import { announce, emit, on } from './events';

const context = () => ({ listeners: {} }) as Pick<WorkerContext, 'listeners'>;

describe('emit', () => {
	test('tells each listener of the event, and not a removed one', () => {
		const target = context();
		const seen: string[] = [];
		const off = on(target, 'stalled', ({ id }) => void seen.push(`a${id}`));
		on(target, 'stalled', ({ id }) => void seen.push(`b${id}`));
		emit(target, 'stalled', { id: '1' });
		off();
		emit(target, 'stalled', { id: '2' });
		expect(seen).toEqual(['a1', 'b1', 'b2']);
	});

	test('a listener that throws is reported on error', () => {
		const target = context();
		const errors: unknown[] = [];
		on(target, 'error', (e) => void errors.push(e));
		on(target, 'stalled', () => {
			throw new Error('bad');
		});
		emit(target, 'stalled', { id: '1' });
		expect((errors[0] as Error).message).toBe('bad');
	});

	test('a listener of error that throws is swallowed', () => {
		const target = context();
		on(target, 'error', () => {
			throw new Error('bad');
		});
		expect(() => emit(target, 'error', new Error('x'))).not.toThrow();
	});

	test('a listener whose promise rejects is reported on error', async () => {
		const target = context();
		const errors: unknown[] = [];
		on(target, 'error', (e) => void errors.push(e));
		on(target, 'stalled', (async () => {
			throw new Error('late');
		}) as () => void);
		emit(target, 'stalled', { id: '1' });
		await eventually(() => errors.length, 1);
		expect((errors[0] as Error).message).toBe('late');
	});

	test('a non-Promise thenable that rejects is reported on error', async () => {
		const target = context();
		const errors: unknown[] = [];
		on(target, 'error', (e) => void errors.push(e));
		on(target, 'stalled', (() => ({
			// biome-ignore lint/suspicious/noThenProperty: a thenable that is not a Promise is the case under test
			then: (_: unknown, reject: (e: unknown) => void) =>
				reject(new Error('thenable')),
		})) as () => void);
		emit(target, 'stalled', { id: '1' });
		await eventually(() => errors.length, 1);
		expect((errors[0] as Error).message).toBe('thenable');
	});

	test('announce tells a stalled and an invalid job per id', () => {
		const target = context();
		const seen: string[] = [];
		on(target, 'stalled', ({ id }) => void seen.push(`stalled ${id}`));
		on(target, 'failed', ({ id }) => void seen.push(`failed ${id}`));
		announce(target, {
			jobs: [],
			stalled: ['a', 'b'],
			failedInvalid: ['c'],
			next: -1,
		});
		expect(seen).toEqual(['stalled a', 'stalled b', 'failed c']);
	});
});
