import { describe, expect, test } from 'bun:test';
import { periodOf } from './periods';
import { type Candidate, checkPolicy, plan } from './policy';

const NOW = new Date('2026-10-04T12:00:00.000Z');

let serial = 0;
function backup(
	at: string,
	options: Partial<Omit<Candidate, 'createdAt'>> = {},
): Candidate {
	serial++;
	return {
		id: options.id ?? `b${String(serial).padStart(3, '0')}`,
		createdAt: new Date(at),
		storedSize: options.storedSize ?? 100,
		parent: options.parent ?? null,
		held: options.held ?? false,
		...(options.standIn ? { standIn: true } : {}),
	};
}

const ids = (decisions: { id: string }[]) => decisions.map((d) => d.id);

describe('plan', () => {
	test('last keeps the newest, whatever order they come in', () => {
		const a = backup('2026-10-01T00:00:00Z', { id: 'a' });
		const b = backup('2026-10-02T00:00:00Z', { id: 'b' });
		const c = backup('2026-10-03T00:00:00Z', { id: 'c' });
		const result = plan([b, c, a], { last: 2 }, NOW);
		expect(ids(result.kept)).toEqual(['c', 'b']);
		expect(result.kept[0]?.reasons).toEqual(['last 1 of 2']);
		expect(result.removed).toEqual([
			{
				id: 'a',
				createdAt: a.createdAt,
				storedSize: 100,
				reasons: ['no rule keeps it'],
			},
		]);
	});

	test('daily keeps the newest backup of each of the latest days', () => {
		const result = plan(
			[
				backup('2026-10-03T23:00:00Z', { id: 'd3-late' }),
				backup('2026-10-03T01:00:00Z', { id: 'd3-early' }),
				backup('2026-10-02T12:00:00Z', { id: 'd2' }),
				backup('2026-09-30T12:00:00Z', { id: 'd0' }),
			],
			{ daily: 2 },
			NOW,
		);
		expect(ids(result.kept)).toEqual(['d3-late', 'd2']);
		expect(result.kept.map((d) => d.reasons)).toEqual([
			['daily 2026-10-03'],
			['daily 2026-10-02'],
		]);
		expect(ids(result.removed)).toEqual(['d3-early', 'd0']);
	});

	test('rules add up, and each says why', () => {
		const result = plan(
			[
				backup('2026-10-04T11:00:00Z', { id: 'now' }),
				backup('2026-10-04T08:00:00Z', { id: 'morning' }),
				backup('2026-09-15T00:00:00Z', { id: 'september' }),
				backup('2025-06-01T00:00:00Z', { id: 'last-year' }),
			],
			{ last: 1, hourly: 2, monthly: 2, yearly: 2, within: 6 * 3_600_000 },
			NOW,
		);
		const why = Object.fromEntries(result.kept.map((d) => [d.id, d.reasons]));
		expect(why).toEqual({
			now: [
				'last 1 of 1',
				'hourly 2026-10-04T11',
				'monthly 2026-10',
				'yearly 2026',
				'within',
			],
			morning: ['hourly 2026-10-04T08', 'within'],
			september: ['monthly 2026-09'],
			'last-year': ['yearly 2025'],
		});
		expect(result.removed).toEqual([]);
	});

	test('a held backup and one newer than now are kept whatever the rules', () => {
		const result = plan(
			[
				backup('2026-10-05T00:00:00Z', { id: 'future' }),
				backup('2026-10-03T00:00:00Z', { id: 'latest' }),
				backup('2020-01-01T00:00:00Z', { id: 'held', held: true }),
				backup('2021-01-01T00:00:00Z', { id: 'old' }),
			],
			{ last: 1 },
			NOW,
		);
		const why = Object.fromEntries(result.kept.map((d) => [d.id, d.reasons]));
		expect(why).toEqual({
			future: ['newer than now'],
			latest: ['last 1 of 1'],
			held: ['held'],
		});
		expect(ids(result.removed)).toEqual(['old']);
	});

	test('a kept backup keeps what it builds on, all the way down', () => {
		const result = plan(
			[
				backup('2026-10-03T00:00:00Z', { id: 'inc2', parent: 'inc1' }),
				backup('2026-10-02T00:00:00Z', { id: 'inc1', parent: 'full' }),
				backup('2026-10-01T00:00:00Z', { id: 'full' }),
				backup('2026-09-01T00:00:00Z', { id: 'older' }),
			],
			{ last: 1 },
			NOW,
		);
		const why = Object.fromEntries(result.kept.map((d) => [d.id, d.reasons]));
		expect(why).toEqual({
			inc2: ['last 1 of 1'],
			inc1: ['parent of inc2'],
			full: ['parent of inc1'],
		});
		expect(ids(result.removed)).toEqual(['older']);
	});

	test('maxTotalSize drops the oldest kept until the rest fit', () => {
		const result = plan(
			[
				backup('2026-10-03T00:00:00Z', { id: 'c', storedSize: 50 }),
				backup('2026-10-02T00:00:00Z', { id: 'b', storedSize: 50 }),
				backup('2026-10-01T00:00:00Z', { id: 'a', storedSize: 50 }),
			],
			{ daily: 10, maxTotalSize: 120 },
			NOW,
		);
		expect(ids(result.kept)).toEqual(['c', 'b']);
		expect(result.removed.map((d) => [d.id, d.reasons])).toEqual([
			['a', ['over maxTotalSize']],
		]);
		expect(result.overSize).toBe(false);
	});

	test('maxTotalSize never goes below the floor, a hold or a needed parent', () => {
		const result = plan(
			[
				backup('2026-10-03T00:00:00Z', {
					id: 'inc',
					parent: 'full',
					storedSize: 10,
				}),
				backup('2026-10-02T00:00:00Z', { id: 'full', storedSize: 500 }),
				backup('2026-10-01T00:00:00Z', {
					id: 'held',
					held: true,
					storedSize: 500,
				}),
				backup('2026-09-30T00:00:00Z', { id: 'other', storedSize: 500 }),
			],
			{ daily: 10, maxTotalSize: 100 },
			NOW,
		);
		expect(ids(result.kept)).toEqual(['inc', 'full', 'held']);
		expect(ids(result.removed)).toEqual(['other']);
		expect(result.overSize).toBe(true);
	});

	test('the floor is the newest last backups when last is set', () => {
		const result = plan(
			[
				backup('2026-10-03T00:00:00Z', { id: 'c', storedSize: 100 }),
				backup('2026-10-02T00:00:00Z', { id: 'b', storedSize: 100 }),
				backup('2026-10-01T00:00:00Z', { id: 'a', storedSize: 100 }),
			],
			{ last: 2, daily: 3, maxTotalSize: 1 },
			NOW,
		);
		expect(ids(result.kept)).toEqual(['c', 'b']);
		expect(result.overSize).toBe(true);
	});
});

describe('plan, at its edges', () => {
	test('maxTotalSize alone keeps the newest, and only what fits', () => {
		const result = plan(
			[
				backup('2026-10-03T00:00:00Z', { id: 'c', storedSize: 500 }),
				backup('2026-10-02T00:00:00Z', { id: 'b', storedSize: 10 }),
			],
			{ maxTotalSize: 100 },
			NOW,
		);
		expect(result.kept.map((d) => [d.id, d.reasons])).toEqual([
			['c', ['the newest, under maxTotalSize']],
		]);
		expect(ids(result.removed)).toEqual(['b']);
		expect(result.overSize).toBe(true);
	});

	test('a backup from the future takes no place from a real one', () => {
		const result = plan(
			[
				backup('2027-01-01T00:00:00Z', { id: 'future', storedSize: 100 }),
				backup('2026-10-03T00:00:00Z', { id: 'real', storedSize: 100 }),
				backup('2026-10-02T00:00:00Z', { id: 'older', storedSize: 100 }),
			],
			{ last: 1, daily: 2, within: 1000, maxTotalSize: 150 },
			NOW,
		);
		const why = Object.fromEntries(result.kept.map((d) => [d.id, d.reasons]));
		expect(why).toEqual({
			future: ['newer than now'],
			real: ['last 1 of 1', 'daily 2026-10-03'],
		});
		expect(result.removed.map((d) => [d.id, d.reasons])).toEqual([
			['older', ['over maxTotalSize']],
		]);
	});

	test('a parent kept only for a child the size rule dropped goes too', () => {
		const result = plan(
			[
				backup('2026-10-03T00:00:00Z', { id: 'n', storedSize: 10 }),
				backup('2026-10-02T00:00:00Z', {
					id: 'k',
					parent: 'p',
					storedSize: 40,
				}),
				backup('2026-09-01T00:00:00Z', { id: 'p', storedSize: 40 }),
			],
			{ last: 2, maxTotalSize: 50 },
			NOW,
		);
		expect(ids(result.kept)).toEqual(['n', 'k', 'p']);
		expect(result.overSize).toBe(true);
		const relaxed = plan(
			[
				backup('2026-10-03T00:00:00Z', { id: 'n', storedSize: 10 }),
				backup('2026-10-02T00:00:00Z', {
					id: 'k',
					parent: 'p',
					storedSize: 40,
				}),
				backup('2026-09-01T00:00:00Z', { id: 'p', storedSize: 40 }),
			],
			{ last: 1, daily: 2, maxTotalSize: 50 },
			NOW,
		);
		expect(relaxed.kept.map((d) => [d.id, d.reasons])).toEqual([
			['n', ['last 1 of 1', 'daily 2026-10-03']],
		]);
		expect(relaxed.removed.map((d) => [d.id, d.reasons])).toEqual([
			['k', ['over maxTotalSize']],
			['p', ['no rule keeps it']],
		]);
		expect(relaxed.overSize).toBe(false);
	});

	test('within keeps a backup exactly that old, and not one a millisecond older', () => {
		const day = 86_400_000;
		const result = plan(
			[
				backup(new Date(NOW.getTime() - day).toISOString(), { id: 'edge' }),
				backup(new Date(NOW.getTime() - day - 1).toISOString(), { id: 'past' }),
			],
			{ within: day },
			NOW,
		);
		expect(ids(result.kept)).toEqual(['edge']);
		expect(ids(result.removed)).toEqual(['past']);
	});

	test('two backups of the same moment are ordered by id, newest last', () => {
		const at = '2026-10-03T00:00:00Z';
		const result = plan(
			[backup(at, { id: 'x1' }), backup(at, { id: 'x2' })],
			{ last: 1 },
			NOW,
		);
		expect(ids(result.kept)).toEqual(['x2']);
	});
});

describe('plan, with a stand-in', () => {
	test('keeps it and its parent, and gives it no rule', () => {
		const result = plan(
			[
				backup('2026-10-03T00:00:00Z', {
					id: 'unread',
					parent: 'base',
					held: true,
					standIn: true,
					storedSize: 0,
				}),
				backup('2026-10-02T00:00:00Z', { id: 'real' }),
				backup('2026-10-01T00:00:00Z', { id: 'base' }),
			],
			{ last: 1, maxTotalSize: 150 },
			NOW,
		);
		const why = Object.fromEntries(result.kept.map((d) => [d.id, d.reasons]));
		expect(why).toEqual({
			unread: ['held'],
			real: ['last 1 of 1'],
			base: ['parent of unread'],
		});
	});
});

describe('periodOf', () => {
	test('counts ISO weeks across a year boundary, in UTC', () => {
		expect(periodOf('weekly', new Date('2026-01-01T00:00:00Z'))).toBe(
			'2026-W01',
		);
		expect(periodOf('weekly', new Date('2024-12-30T00:00:00Z'))).toBe(
			'2025-W01',
		);
		expect(periodOf('weekly', new Date('2027-01-01T00:00:00Z'))).toBe(
			'2026-W53',
		);
		expect(periodOf('weekly', new Date('2026-10-04T23:59:59Z'))).toBe(
			'2026-W40',
		);
		expect(periodOf('weekly', new Date('2026-10-05T00:00:00Z'))).toBe(
			'2026-W41',
		);
	});

	test('names hours, days, months and years in UTC', () => {
		const at = new Date('2026-03-07T05:30:00Z');
		expect(periodOf('hourly', at)).toBe('2026-03-07T05');
		expect(periodOf('daily', at)).toBe('2026-03-07');
		expect(periodOf('monthly', at)).toBe('2026-03');
		expect(periodOf('yearly', at)).toBe('2026');
	});
});

describe('checkPolicy', () => {
	test('refuses a policy that keeps nothing, or a count that is not one', () => {
		expect(() => checkPolicy({}, 'prune on "app"')).toThrow(
			'prune on "app": keep must name at least one rule',
		);
		for (const bad of [0, -1, 1.5, Number.NaN]) {
			expect(() => checkPolicy({ daily: bad }, 'prune on "app"')).toThrow(
				'prune on "app": keep.daily must be a whole number, 1 or more',
			);
		}
		expect(checkPolicy({ maxTotalSize: 1 }, 'x')).toEqual({ maxTotalSize: 1 });
	});
});
