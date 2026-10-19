import type { z } from 'zod';
import type { Duration } from '../duration';
import type { Cron } from './cron';

/**
 * A recurring job, given to `defineQueue({ schedules })` under its id or to
 * `q.schedules.upsert`: either a cron with an optional time zone, or an
 * interval, never both. `data` is the payload each occurrence is added with,
 * checked by the queue's schema.
 *
 * ```ts
 * { cron: '30 18 * * *', timezone: 'Europe/Paris', data }
 * { every: '10m', data }
 * ```
 */
export type Schedule<S extends z.ZodType> =
	| {
			/** Five fields: minute hour day-of-month month day-of-week. */
			cron: string;
			/** An IANA time zone name. Default `'UTC'`. */
			timezone?: string;
			every?: never;
			data: z.input<S>;
	  }
	| {
			/** The interval, at least 1 second. */
			every: Duration;
			cron?: never;
			timezone?: never;
			data: z.input<S>;
	  };

/** A schedule as `q.schedules.list` shows it. */
export type ScheduleView<S extends z.ZodType> = {
	id: string;
	/** The cron text, for a cron schedule. */
	cron?: string;
	/** The interval in milliseconds, for an `every` schedule. */
	every?: number;
	/** The cron's time zone. */
	timezone?: string;
	/** `undefined` when the stored payload no longer parses with the schema. */
	data: z.output<S> | undefined;
	/** `definition` for a `defineQueue` schedule, `runtime` for an `upsert`. */
	origin: 'definition' | 'runtime';
	/** When the schedule is next due. */
	next: Date;
};

/** What a bound queue's `schedules` offers. */
export type QueueSchedules<S extends z.ZodType> = {
	/**
	 * Stores or replaces a runtime schedule under `id`, its first occurrence
	 * computed now. One round trip.
	 *
	 * @throws TypeError for a malformed schedule or id, before any round trip,
	 * and for an id that belongs to the definition.
	 * @throws QueueError `INVALID` when the schema refuses `data`.
	 */
	upsert(id: string, schedule: Schedule<S>): Promise<void>;
	/**
	 * Removes a runtime schedule. Occurrences already added stay.
	 *
	 * @throws QueueError `NOT_FOUND` when there is none.
	 * @throws TypeError for an id that belongs to the definition.
	 */
	remove(id: string): Promise<void>;
	/**
	 * One page of the schedules, soonest `next` first, one round trip.
	 *
	 * @param page - `offset` from 0, default 0; `limit` from 1 to 1000, default 100.
	 * @throws TypeError for an `offset` or `limit` out of range.
	 */
	list(page?: { offset?: number; limit?: number }): Promise<ScheduleView<S>[]>;
};

/**
 * A schedule of the definition, resolved: what SYNC stores. `data` is the
 * JSON of the schema's output; `timezone` is `''` for an interval, whose
 * `spec` is its milliseconds as text.
 */
export type ScheduleDefinition = {
	readonly id: string;
	readonly spec: string;
	readonly timezone: string;
	readonly data: string;
} & (
	| { readonly kind: 'cron'; readonly cron: Cron }
	| { readonly kind: 'every'; readonly everyMs: number }
);
