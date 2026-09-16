// What the aggregation helpers' types give and refuse, checked by `tsc` and never run.

import type { Db, ObjectId } from 'mongodb';
import { z } from 'zod';
import type { ReadDocumentOf } from '../../src';
import { defineCollection, getCollection } from '../../src';
import { members, teams } from '../relations';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
function assertType<T extends true>(_: T): void {}

declare const db: Db;
const people = getCollection(db, members);
const team = getCollection(db, teams);

/** A collection keyed by strings: an ObjectId field cannot point to it. */
const slugs = defineCollection({
	name: 'slugs',
	schema: z.object({ _id: z.string(), label: z.string() }),
});
const slug = getCollection(db, slugs);

export async function distincts() {
	const levels = await people.distinct('level');
	assertType<Equal<typeof levels, string[]>>(true);
	// An array field gives its elements.
	const tags = await people.distinct('tags', { name: 'Ada' });
	assertType<Equal<typeof tags, string[]>>(true);
	const teamIds = await people.distinct('teamId');
	assertType<Equal<typeof teamIds, (ObjectId | null)[]>>(true);

	// @ts-expect-error no such field
	await people.distinct('nope');
	// @ts-expect-error the filter is typed by the schema
	await people.distinct('level', { score: 'high' });
}

export async function groups() {
	const byTeam = await people.groupBy('teamId', {
		measures: {
			total: { sum: 'score' },
			mean: { avg: 'score' },
			first: { min: 'name' },
			best: { max: 'score' },
		},
		sort: 'key',
	});
	const [group] = byTeam;
	if (group) {
		assertType<Equal<typeof group.key, ObjectId | null>>(true);
		assertType<Equal<typeof group.count, number>>(true);
		assertType<Equal<typeof group.total, number>>(true);
		assertType<Equal<typeof group.mean, number | null>>(true);
		assertType<Equal<typeof group.first, string | null>>(true);
		assertType<Equal<typeof group.best, number | null>>(true);
	}
	// An optional field: the documents without it are the `null` group.
	const [byLevel] = await people.groupBy('level');
	if (byLevel) {
		assertType<Equal<typeof byLevel.key, string | null>>(true);
		// @ts-expect-error no measure was asked for
		byLevel.total;
	}

	// @ts-expect-error no such field
	await people.groupBy('nope');
	// @ts-expect-error a name is not a number: nothing to sum
	await people.groupBy('level', { measures: { total: { sum: 'name' } } });
	// @ts-expect-error nor to average
	await people.groupBy('level', { measures: { mean: { avg: 'tags' } } });
	// @ts-expect-error no such field to take the least of
	await people.groupBy('level', { measures: { low: { min: 'nope' } } });
	// @ts-expect-error `count` is the group's own
	await people.groupBy('level', { measures: { count: { sum: 'score' } } });
	// @ts-expect-error `key` too
	await people.groupBy('level', { measures: { key: { max: 'score' } } });
	// @ts-expect-error no such measure
	await people.groupBy('level', { measures: { mid: { median: 'score' } } });
	// @ts-expect-error by count or by key
	await people.groupBy('level', { sort: 'size' });
}

export async function populations() {
	const found = await people.findMany();
	const [one] = await people.populate(found, {
		team: { from: team, by: 'teamId' },
		mentors: { from: people, by: 'mentorIds' },
		mentees: { from: people, on: 'mentorIds' },
	});
	if (one) {
		assertType<Equal<typeof one.team, ReadDocumentOf<typeof teams> | null>>(
			true,
		);
		assertType<Equal<typeof one.mentors, ReadDocumentOf<typeof members>[]>>(
			true,
		);
		assertType<Equal<typeof one.mentees, ReadDocumentOf<typeof members>[]>>(
			true,
		);
		// The document's own fields are still there.
		assertType<Equal<typeof one.name, string>>(true);
	}
	const [withMembers] = await team.populate(await team.findMany(), {
		members: { from: people, on: 'teamId' },
	});
	if (withMembers) {
		assertType<
			Equal<typeof withMembers.members, ReadDocumentOf<typeof members>[]>
		>(true);
	}

	// @ts-expect-error a name is no reference
	await people.populate(found, { team: { from: team, by: 'name' } });
	// @ts-expect-error no such field
	await people.populate(found, { team: { from: team, by: 'nope' } });
	// @ts-expect-error an ObjectId does not point to a string-keyed collection
	await people.populate(found, { slug: { from: slug, by: 'teamId' } });
	// @ts-expect-error members' name does not point to teams
	await team.populate([], { members: { from: people, on: 'name' } });
	// @ts-expect-error `name` is a field already: it would be overwritten
	await people.populate(found, { name: { from: team, by: 'teamId' } });
	// @ts-expect-error `id` is computed on every document
	await people.populate(found, { id: { from: team, by: 'teamId' } });
	// @ts-expect-error one of `by` or `on`, not both
	await people.populate(found, { t: { from: team, by: 'teamId', on: 'x' } });
	// @ts-expect-error a relation reads from a collection
	await people.populate(found, { team: { from: teams, by: 'teamId' } });
	// @ts-expect-error only this collection's documents
	await people.populate(await team.findMany(), {
		team: { from: team, by: 'teamId' },
	});
}
