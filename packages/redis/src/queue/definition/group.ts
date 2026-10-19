import type { QueueGroups, QueueGroupsInput } from '../types/flow-types';
import { isName, MAX_NAME } from './name';

/**
 * Checks a queue's `groups` and resolves it: frozen, `concurrency` 0 for no
 * cap. `undefined` stays `undefined`, an ungrouped queue. A definition written
 * by hand (`resolved`, as `checkResolved` takes schedules) may hold the
 * resolved 0, which `defineQueue` never accepts as input.
 *
 * @throws TypeError for a value that could never work, named after `call` and
 * the queue.
 */
export function resolveGroups(
	value: QueueGroupsInput | QueueGroups | undefined,
	call: string,
	name: string,
	resolved: boolean,
): QueueGroups | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'object' || value === null) {
		throw new TypeError(
			`${call}: "${name}" has groups that is not an object; it is { concurrency? }`,
		);
	}
	const { concurrency } = value;
	if (concurrency === undefined) return Object.freeze({ concurrency: 0 });
	if (!Number.isSafeInteger(concurrency) || concurrency < (resolved ? 0 : 1)) {
		throw new TypeError(
			`${call}: "${name}" has groups concurrency; it is a whole number of jobs per group, at least 1, or left out for no cap`,
		);
	}
	return Object.freeze({ concurrency });
}

/**
 * Checks `add`'s `group` and answers it, `''` for the default group. A group
 * on a queue without `groups` is refused before any round trip, and so is one
 * that is not a name: 1 to {@link MAX_NAME} characters, no braces and no
 * colons, which the group's keys join. No message prints the value.
 */
export function resolveGroup(
	group: unknown,
	grouped: boolean,
	call: string,
	queue: string,
): string {
	if (group === undefined) return '';
	if (!grouped) {
		throw new TypeError(
			`${call} on "${queue}": group needs groups in defineQueue`,
		);
	}
	if (!isName(group) || group.includes(':')) {
		throw new TypeError(
			`${call} on "${queue}": group is a string of 1 to ${MAX_NAME} characters without braces or colons`,
		);
	}
	return group;
}
