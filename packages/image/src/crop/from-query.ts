import type { CropBox } from '../set/types';

const NAMES = ['x', 'y', 'size'] as const;

function numberOf(params: URLSearchParams, name: (typeof NAMES)[number]) {
	const value = params.get(name);
	return value === null || value.trim() === '' ? Number.NaN : Number(value);
}

/**
 * The square crop an upload route reads from `?x=&y=&size=`.
 *
 * - None of the three present: `undefined`, the default centred crop.
 * - Otherwise a `CropBox`, where a missing, blank or non-numeric value is
 *   `NaN`. Nothing is validated here: the set refuses it as `INVALID_CROP`,
 *   a refusal to answer with a 4xx.
 */
export function cropFromQuery(params: URLSearchParams): CropBox | undefined {
	if (NAMES.every((name) => !params.has(name))) return undefined;
	return {
		x: numberOf(params, 'x'),
		y: numberOf(params, 'y'),
		size: numberOf(params, 'size'),
	};
}
