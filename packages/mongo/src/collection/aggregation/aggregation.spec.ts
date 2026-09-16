import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import {
	bookings,
	events,
	members,
	slots,
	teams,
} from '../../../test/relations';
import { startMongo, type TestServer } from '../../../test/server';
import { withTransaction } from '../../transaction/with-transaction';
import { getCollection } from '../get-collection';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo('nxgt-aggregation');
}, 120_000);
beforeEach(async () => {
	await t.reset();
	await getCollection(t.db, teams).sync();
	await getCollection(t.db, members).sync();
	await getCollection(t.db, events).sync();
	await getCollection(t.db, slots).sync();
	await getCollection(t.db, bookings).sync();
});
afterAll(async () => {
	await t.stop();
});

async function seed() {
	const team = getCollection(t.db, teams);
	const people = getCollection(t.db, members);
	const core = await team.create({ name: 'Core' });
	const web = await team.create({ name: 'Web' });
	const ada = await people.create({
		name: 'Ada',
		teamId: core._id,
		level: 'senior',
		score: 10,
		tags: ['ts', 'db'],
	});
	const bob = await people.create({
		name: 'Bob',
		teamId: core._id,
		level: 'junior',
		score: 4,
		mentorIds: [ada._id],
		tags: ['ts'],
	});
	const cy = await people.create({
		name: 'Cy',
		teamId: web._id,
		level: 'senior',
		mentorIds: [bob._id, ada._id],
	});
	const gone = await people.create({
		name: 'Gone',
		teamId: web._id,
		score: 99,
	});
	await people.delete(gone._id);
	return { team, people, core, web, ada, bob, cy, gone };
}

describe('distinct', () => {
	test('lists the values, soft-deleted documents left out', async () => {
		const { people } = await seed();
		const levels = await people.distinct('level');
		expect(levels.sort()).toEqual(['junior', 'senior']);
		expect((await people.distinct('score')).sort()).toEqual([10, 4]);
		expect(
			(await people.distinct('score', {}, { withDeleted: true })).length,
		).toBe(3);
	});

	test('gives an array field its elements, and takes a filter', async () => {
		const { people } = await seed();
		expect((await people.distinct('tags')).sort()).toEqual(['db', 'ts']);
		expect(await people.distinct('tags', { name: 'Bob' })).toEqual(['ts']);
	});

	test('is not the driver’s, which is on raw', async () => {
		const { people } = await seed();
		expect((await people.raw.distinct('score')).length).toBe(3);
	});
});

describe('groupBy', () => {
	test('counts each group, largest first, and computes the measures', async () => {
		const { people, core, web } = await seed();
		const groups = await people.groupBy('teamId', {
			measures: {
				total: { sum: 'score' },
				mean: { avg: 'score' },
				first: { min: 'name' },
				last: { max: 'name' },
			},
		});
		expect(groups).toEqual([
			{
				key: core._id,
				count: 2,
				total: 14,
				mean: 7,
				first: 'Ada',
				last: 'Bob',
			},
			{ key: web._id, count: 1, total: 0, mean: null, first: 'Cy', last: 'Cy' },
		]);
	});

	test('keys documents without the field as null, and sorts by key on request', async () => {
		const { people } = await seed();
		await people.create({ name: 'Dee' });
		const groups = await people.groupBy('level', { sort: 'key' });
		expect(groups).toEqual([
			{ key: null, count: 1 },
			{ key: 'junior', count: 1 },
			{ key: 'senior', count: 2 },
		]);
	});

	test('takes a filter, a limit, and the deleted on request', async () => {
		const { people } = await seed();
		expect(
			await people.groupBy('level', { filter: { name: { $ne: 'Cy' } } }),
		).toEqual([
			{ key: 'junior', count: 1 },
			{ key: 'senior', count: 1 },
		]);
		expect(await people.groupBy('level', { limit: 1 })).toEqual([
			{ key: 'senior', count: 2 },
		]);
		const all = await people.groupBy('level', { withDeleted: true });
		expect(all.reduce((n, g) => n + g.count, 0)).toBe(4);
	});

	test('refuses a measure it cannot name or read, as a rejection', async () => {
		const { people } = await seed();
		const bad = [
			{ count: { sum: 'score' } },
			{ key: { sum: 'score' } },
			// It would replace what the documents are grouped on.
			{ _id: { sum: 'score' } },
			{ $x: { sum: 'score' } },
			{ 'a.b': { sum: 'score' } },
			{ total: { sum: 'score', avg: 'score' } },
			{ total: { median: 'score' } },
			{ total: { sum: 5 } },
			{ total: 'score' },
		];
		for (const measures of bad) {
			await expect(
				people.groupBy('level', { measures } as never),
			).rejects.toThrow(TypeError);
		}
		await expect(
			people.groupBy('level', { sort: 'size' } as never),
		).rejects.toThrow("sort is 'count' or 'key'");
		for (const limit of [0, -1, 1.5, Number.NaN]) {
			await expect(people.groupBy('level', { limit })).rejects.toThrow(
				'limit must be a whole number',
			);
		}
	});
});

describe('populate', () => {
	test('follows a reference, and a list of them, in their order', async () => {
		const { team, people, core, ada, bob, cy } = await seed();
		const found = await people.findMany({ sort: { name: 1 } });
		const populated = await people.populate(found, {
			team: { from: team, by: 'teamId' },
			mentors: { from: people, by: 'mentorIds' },
		});
		expect(populated.map((m) => m.team?.name)).toEqual(['Core', 'Core', 'Web']);
		expect(populated[0]?.team?._id).toEqual(core._id);
		expect(populated.map((m) => m.mentors.map((x) => x.name))).toEqual([
			[],
			['Ada'],
			['Bob', 'Ada'],
		]);
		expect(populated.map((m) => m._id)).toEqual([ada._id, bob._id, cy._id]);
		// The documents given are left alone.
		expect('team' in (found[0] as object)).toBe(false);
	});

	test('gathers the documents that point back, deleted ones left out', async () => {
		const { team, people, web } = await seed();
		const found = await team.findMany({ sort: { name: 1 } });
		const [core, webTeam] = await team.populate(found, {
			members: { from: people, on: 'teamId' },
			everyone: { from: people, on: 'teamId', withDeleted: true },
		});
		expect(core?.members.map((m) => m.name)).toEqual(['Ada', 'Bob']);
		expect(webTeam?._id).toEqual(web._id);
		expect(webTeam?.members.map((m) => m.name)).toEqual(['Cy']);
		expect(webTeam?.everyone.map((m) => m.name)).toEqual(['Cy', 'Gone']);
	});

	test('answers null for a missing or deleted target, and [] for none', async () => {
		const { team, people, web } = await seed();
		await team.delete(web._id);
		const loner = await people.create({ name: 'Lone' });
		const [cy, lone] = await people.populate(
			await people.findMany({
				filter: { name: { $in: ['Cy', 'Lone'] } },
				sort: { name: 1 },
			}),
			{
				team: { from: team, by: 'teamId' },
				mentees: { from: people, on: 'mentorIds' },
			},
		);
		expect(cy?.team).toBeNull();
		expect(lone?._id).toEqual(loner._id);
		expect(lone?.team).toBeNull();
		expect(lone?.mentees).toEqual([]);
		expect(cy?.mentees).toEqual([]);
	});

	test('gives a list field a list, even when it is missing', async () => {
		const { people, ada, bob } = await seed();
		await people.update(ada._id, { reviewerIds: [bob._id] });
		const [first, second] = await people.populate(
			await people.findMany({
				filter: { name: { $in: ['Ada', 'Bob'] } },
				sort: { name: 1 },
			}),
			{ reviewers: { from: people, by: 'reviewerIds' } },
		);
		expect(first?.reviewers.map((m) => m.name)).toEqual(['Bob']);
		// Bob has no `reviewerIds` at all.
		expect(second?.reviewers).toEqual([]);
	});

	test('follows a deleted target when asked', async () => {
		const { team, people, web } = await seed();
		await team.delete(web._id);
		const [cy] = await people.populate(
			await people.findMany({ filter: { name: 'Cy' } }),
			{
				hidden: { from: team, by: 'teamId' },
				shown: { from: team, by: 'teamId', withDeleted: true },
			},
		);
		expect(cy?.hidden).toBeNull();
		expect(cy?.shown?.name).toBe('Web');
	});

	test('counts a document that points back twice once', async () => {
		const { people, ada, bob } = await seed();
		await people.update(bob._id, { mentorIds: [ada._id, ada._id] });
		const [first] = await people.populate(
			await people.findMany({ filter: { name: 'Ada' } }),
			{ mentees: { from: people, on: 'mentorIds' } },
		);
		expect(first?.mentees.map((m) => m.name)).toEqual(['Bob', 'Cy']);
	});

	test('matches ids that are dates or documents by value', async () => {
		const agenda = getCollection(t.db, events);
		const rooms = getCollection(t.db, slots);
		const booked = getCollection(t.db, bookings);
		const early = new Date('2026-01-01T10:00:00.001Z');
		const late = new Date('2026-01-01T10:00:00.002Z');
		await agenda.create({ _id: early, label: 'early' });
		await agenda.create({ _id: late, label: 'late' });
		await rooms.create({ _id: { room: 'a', hour: 1 }, label: 'a1' });
		await rooms.create({ _id: { room: 'b', hour: 2 }, label: 'b2' });
		await booked.create({
			eventAt: new Date(early.getTime()),
			slotIds: [
				{ room: 'b', hour: 2 },
				{ room: 'a', hour: 1 },
			],
		});
		await booked.create({ eventAt: new Date(late.getTime()), slotIds: [] });
		const populated = await booked.populate(
			await booked.findMany({ sort: { eventAt: 1 } }),
			{
				event: { from: agenda, by: 'eventAt' },
				slots: { from: rooms, by: 'slotIds' },
			},
		);
		expect(populated.map((b) => b.event?.label)).toEqual(['early', 'late']);
		expect(populated.map((b) => b.slots.map((s) => s.label))).toEqual([
			['b2', 'a1'],
			[],
		]);
	});

	test('sends one query per relation, whatever the number of documents', async () => {
		const { team, people } = await seed();
		const found = await people.findMany();
		let finds = 0;
		const counted = new Proxy(team, {
			get(target, key, receiver) {
				if (key === 'findMany') {
					return (options: never) => {
						finds += 1;
						return target.findMany(options);
					};
				}
				return Reflect.get(target, key, receiver);
			},
		});
		await people.populate(found, { team: { from: counted, by: 'teamId' } });
		expect(finds).toBe(1);
		await people.populate([], { team: { from: counted, by: 'teamId' } });
		expect(finds).toBe(1);
	});

	test('reads the related collection in its own session', async () => {
		const { team, people, core } = await seed();
		await withTransaction(t.client, async (session) => {
			const inside = team.withSession(session);
			const lab = await inside.create({ name: 'Lab' });
			await people
				.withSession(session)
				.update((await people.findFirst({ name: 'Ada' }))?._id as never, {
					teamId: lab._id,
				});
			const [ada] = await people
				.withSession(session)
				.populate(
					await people
						.withSession(session)
						.findMany({ filter: { name: 'Ada' } }),
					{ team: { from: inside, by: 'teamId' } },
				);
			expect(ada?.team?.name).toBe('Lab');
			const [outside] = await people.populate(
				await people.findMany({ filter: { name: 'Ada' } }),
				{ team: { from: team, by: 'teamId' } },
			);
			expect(outside?.team?._id).toEqual(core._id);
		});
	});

	test('refuses a relation it cannot follow', async () => {
		const { team, people } = await seed();
		const bad = [
			{ team: { by: 'teamId' } },
			{ team: { from: team } },
			{ team: { from: team, by: 'teamId', on: 'x' } },
		];
		for (const relations of bad) {
			await expect(people.populate([], relations as never)).rejects.toThrow(
				TypeError,
			);
		}
	});
});
