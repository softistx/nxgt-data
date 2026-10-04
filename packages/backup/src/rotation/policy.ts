/**
 * Which backups to keep. Rules add up: a backup any rule keeps is kept.
 * Calendar rules count in UTC, newest first, and keep the newest backup of
 * each period — `daily: 7` keeps the last backup of each of the 7 most
 * recent days that have one.
 */
export interface KeepPolicy {
	/** The newest `last` backups. */
	last?: number | undefined;
	hourly?: number | undefined;
	daily?: number | undefined;
	/** ISO weeks, Monday first. */
	weekly?: number | undefined;
	monthly?: number | undefined;
	yearly?: number | undefined;
	/** Every backup younger than this, in milliseconds. */
	within?: number | undefined;
	/**
	 * At most this many stored bytes in all: the oldest kept backups go
	 * until the rest fit — never the newest `last` (the newest, without
	 * `last`, which this rule then keeps), a held one, or one a kept backup
	 * builds on.
	 */
	maxTotalSize?: number | undefined;
}

/** A backup as the plan sees it. */
export interface Candidate {
	id: string;
	createdAt: Date;
	storedSize: number;
	/** The backup it builds on, if any: kept for as long as it is. */
	parent: string | null;
	held: boolean;
}

/** One backup's fate, and why. */
export interface Decision {
	id: string;
	createdAt: Date;
	storedSize: number;
	reasons: string[];
}

export interface Plan {
	kept: Decision[];
	removed: Decision[];
	/** `maxTotalSize` is set, and what is kept is still over it. */
	overSize: boolean;
}

const CALENDAR = ['hourly', 'daily', 'weekly', 'monthly', 'yearly'] as const;
const RULES = ['last', ...CALENDAR, 'within', 'maxTotalSize'] as const;

/** The policy, checked: at least one rule, each a whole number above 0. */
export function checkPolicy(policy: KeepPolicy, where: string): KeepPolicy {
	if (typeof policy !== 'object' || policy === null) {
		throw new TypeError(`${where}: keep must name at least one rule`);
	}
	let any = false;
	for (const rule of RULES) {
		const value = policy[rule];
		if (value === undefined) continue;
		if (!Number.isSafeInteger(value) || value < 1) {
			throw new TypeError(
				`${where}: keep.${rule} must be a whole number, 1 or more`,
			);
		}
		any = true;
	}
	if (!any) throw new TypeError(`${where}: keep must name at least one rule`);
	return policy;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** The ISO week of `date`, in UTC: `2026-W40`. */
function isoWeek(date: Date): string {
	const day = new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
	);
	const weekday = day.getUTCDay() || 7;
	day.setUTCDate(day.getUTCDate() + 4 - weekday);
	const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
	const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
	return `${day.getUTCFullYear()}-W${pad(week)}`;
}

export function periodOf(rule: (typeof CALENDAR)[number], date: Date): string {
	const y = date.getUTCFullYear();
	const m = pad(date.getUTCMonth() + 1);
	const d = pad(date.getUTCDate());
	switch (rule) {
		case 'hourly':
			return `${y}-${m}-${d}T${pad(date.getUTCHours())}`;
		case 'daily':
			return `${y}-${m}-${d}`;
		case 'weekly':
			return isoWeek(date);
		case 'monthly':
			return `${y}-${m}`;
		case 'yearly':
			return `${y}`;
	}
}

/**
 * Why each backup is kept, by the rules alone. A backup newer than `now` is
 * kept for that alone, and takes no place in `last`, the calendar or the
 * floor: a creator whose clock runs fast must not push a real backup out.
 */
function byRules(
	newest: readonly Candidate[],
	policy: KeepPolicy,
	now: Date,
): Map<string, string[]> {
	const reasons = new Map<string, string[]>(newest.map((c) => [c.id, []]));
	const add = (id: string, why: string) => reasons.get(id)?.push(why);
	const past = newest.filter((c) => c.createdAt.getTime() <= now.getTime());
	past.slice(0, policy.last ?? 0).forEach((c, i) => {
		add(c.id, `last ${i + 1} of ${policy.last}`);
	});
	if (policy.maxTotalSize !== undefined && policy.last === undefined) {
		const newestPast = past[0];
		if (newestPast) add(newestPast.id, 'the newest, under maxTotalSize');
	}
	for (const rule of CALENDAR) {
		let left = policy[rule] ?? 0;
		let previous: string | undefined;
		for (const c of past) {
			if (left === 0) break;
			const period = periodOf(rule, c.createdAt);
			if (period === previous) continue;
			previous = period;
			left--;
			add(c.id, `${rule} ${period}`);
		}
	}
	for (const c of newest) {
		const age = now.getTime() - c.createdAt.getTime();
		if (policy.within !== undefined && age >= 0 && age <= policy.within) {
			add(c.id, 'within');
		}
		if (age < 0) add(c.id, 'newer than now');
		if (c.held) add(c.id, 'held');
	}
	return reasons;
}

/** The reasons, with every backup a kept one builds on kept too. */
function withParents(
	newest: readonly Candidate[],
	byRule: ReadonlyMap<string, readonly string[]>,
	dropped: ReadonlySet<string>,
): Map<string, string[]> {
	const reasons = new Map<string, string[]>(
		newest.map((c) => [
			c.id,
			dropped.has(c.id) ? [] : [...(byRule.get(c.id) ?? [])],
		]),
	);
	const byId = new Map(newest.map((c) => [c.id, c]));
	const pending = newest.filter((c) => reasons.get(c.id)?.length);
	while (pending.length > 0) {
		const child = pending.pop() as Candidate;
		const parent = child.parent === null ? undefined : byId.get(child.parent);
		if (!parent) continue;
		const why = reasons.get(parent.id) as string[];
		const first = why.length === 0;
		why.push(`parent of ${child.id}`);
		if (first) pending.push(parent);
	}
	return reasons;
}

/**
 * The oldest kept backup the size rule may drop: not the floor — the
 * newest `last`, or the newest — not a held one, not one newer than now,
 * and not one a kept backup builds on.
 */
function droppable(
	newest: readonly Candidate[],
	reasons: ReadonlyMap<string, readonly string[]>,
	policy: KeepPolicy,
	now: Date,
): Candidate | undefined {
	const past = newest.filter((c) => c.createdAt.getTime() <= now.getTime());
	const floor = new Set(past.slice(0, policy.last ?? 1).map((c) => c.id));
	const kept = newest.filter((c) => reasons.get(c.id)?.length);
	return [...kept]
		.reverse()
		.find(
			(c) =>
				!floor.has(c.id) &&
				!c.held &&
				c.createdAt.getTime() <= now.getTime() &&
				!kept.some((k) => k.parent === c.id),
		);
}

/** Which backups the policy keeps, which it removes, and why. */
export function plan(
	candidates: readonly Candidate[],
	policy: KeepPolicy,
	now: Date,
): Plan {
	const newest = [...candidates].sort(
		(a, b) =>
			b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1),
	);
	const byRule = byRules(newest, policy, now);
	const dropped = new Set<string>();
	let reasons = withParents(newest, byRule, dropped);
	let overSize = false;
	const max = policy.maxTotalSize;
	// Recomputed after each drop: a parent kept only for a child that went
	// stops being kept, and may go in turn.
	while (max !== undefined) {
		const total = newest
			.filter((c) => reasons.get(c.id)?.length)
			.reduce((sum, c) => sum + c.storedSize, 0);
		if (total <= max) break;
		const next = droppable(newest, reasons, policy, now);
		if (!next) {
			overSize = true;
			break;
		}
		dropped.add(next.id);
		reasons = withParents(newest, byRule, dropped);
	}
	const decision = (c: Candidate, why: string[]): Decision => ({
		id: c.id,
		createdAt: c.createdAt,
		storedSize: c.storedSize,
		reasons: why,
	});
	const kept: Decision[] = [];
	const removed: Decision[] = [];
	for (const c of newest) {
		const why = reasons.get(c.id) as string[];
		if (why.length > 0) kept.push(decision(c, why));
		else if (dropped.has(c.id) || (byRule.get(c.id)?.length ?? 0) > 0)
			removed.push(decision(c, ['over maxTotalSize']));
		else removed.push(decision(c, ['no rule keeps it']));
	}
	return { kept, removed, overSize };
}
