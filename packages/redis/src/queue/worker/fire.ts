import { runScript } from '../../scripts/run-script';
import { type Cron, parseCron } from '../schedule/cron';
import { nextAfter, nextEvery } from '../schedule/next';
import { scriptKeys } from '../scripts/claim';
import type { DueSchedule } from '../scripts/replies';
import { DEFER, FIRE } from '../scripts/schedule';
import type { WorkerContext } from './context';
import { emit } from './events';

/** The longest a worker blocks: how it notices a token that went missing. */
export const MAX_WAIT = 5_000;

/** How long a schedule whose spec no longer parses is put aside. */
const DEFER_MS = 3_600_000;

/** How many parsed crons are kept: parsing walks a 400-year cycle, 2 to 4 ms. */
const MAX_PARSED = 500;

/** What one round of firing did. */
export interface FireRound {
	/** FIRE and DEFER calls sent, whatever they answered. */
	sent: number;
	/** Occurrences added as jobs. */
	added: number;
	/** The earliest ms a fired schedule is due again; infinite when none fired. */
	soonest: number;
}

const parsed = new Map<string, Cron>();

function cronOf(spec: string): Cron {
	let cron = parsed.get(spec);
	if (!cron) {
		cron = parseCron(spec);
		if (parsed.size >= MAX_PARSED) parsed.clear();
		parsed.set(spec, cron);
	}
	return cron;
}

/**
 * The occurrence after `schedule.due`, and after `now` too, so an outage fires
 * the missed one once and the grid keeps its phase.
 *
 * @throws when the spec or the zone no longer parses.
 */
function nextOf(schedule: DueSchedule, now: number): number {
	if (schedule.kind === 'every') {
		const everyMs = Number(schedule.spec);
		if (!Number.isSafeInteger(everyMs) || everyMs < 1000) {
			throw new TypeError('the interval is not whole ms of at least 1000');
		}
		return nextEvery(schedule.due, everyMs, now);
	}
	return nextAfter(
		cronOf(schedule.spec),
		schedule.timezone,
		Math.max(schedule.due, now),
	);
}

/**
 * How long the loop waits for work: the claim's `next` (a 0 only when this
 * round sent a FIRE or DEFER, which is what makes the next page worth fetching
 * at once), and never past the moment a schedule this round fired is due again.
 */
export function waitMs(next: number, round: FireRound, now: number): number {
	const base = next < 0 || (next === 0 && round.sent === 0) ? MAX_WAIT : next;
	return Math.max(0, Math.min(base, MAX_WAIT, round.soonest - now));
}

/**
 * Fires each due schedule a claim reported: one FIRE for the next occurrence
 * it computes, or, for a spec that no longer parses, a DEFER an hour on and an
 * `error` event. Never throws: a failed call is an `error` event and ends the
 * round.
 */
export async function fireDue(
	context: WorkerContext,
	schedules: readonly DueSchedule[],
): Promise<FireRound> {
	const round: FireRound = {
		sent: 0,
		added: 0,
		soonest: Number.POSITIVE_INFINITY,
	};
	const { client, keys, definition } = context;
	for (const schedule of schedules) {
		if (!context.open) break;
		try {
			const now = Date.now();
			let next: number | undefined;
			try {
				next = nextOf(schedule, now);
			} catch {
				// The error names the schedule, never its spec.
				emit(
					context,
					'error',
					new TypeError(
						`schedule "${schedule.id}" of "${definition.name}" no longer parses; deferred for an hour`,
					),
				);
			}
			round.sent += 1;
			if (next === undefined) {
				await runScript(
					client,
					DEFER,
					[keys.schedules],
					[keys.schedule, schedule.id, schedule.due, now + DEFER_MS],
				);
				continue;
			}
			const added = await runScript(client, FIRE, scriptKeys(keys), [
				keys.prefix,
				keys.schedule,
				schedule.id,
				schedule.due,
				next,
				definition.attempts,
				definition.timeout ?? -1,
			]);
			if (added === 1) round.added += 1;
			round.soonest = Math.min(round.soonest, next);
		} catch (error) {
			if (context.open) emit(context, 'error', error);
			break;
		}
	}
	return round;
}
