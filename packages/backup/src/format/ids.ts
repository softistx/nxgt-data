/**
 * A backup's id: its UTC start time to the millisecond, then 8 random hex
 * digits — `20261003T221500123Z-9f3a61c0`. Ids sort as their times do, so a
 * repository's listing is already in order, and two runs started in the same
 * millisecond still differ.
 */
const ID = /^\d{8}T\d{9}Z-[0-9a-f]{8}$/;

export function newBackupId(at: Date): string {
	const stamp = at.toISOString().replace(/[-:]/g, '').replace('.', '');
	const random = crypto.getRandomValues(new Uint8Array(4));
	return `${stamp}-${Buffer.from(random).toString('hex')}`;
}

export function isBackupId(id: unknown): id is string {
	return typeof id === 'string' && ID.test(id);
}
