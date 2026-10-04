import { describe, expect, test } from 'bun:test';
import type { BackupInfo } from '@nxgt/backup';
import { chosenBackup, kindFor } from './plan';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-04T12:00:00Z');
const made = (
	kind: 'full' | 'incremental',
	age: number,
	id = 'x',
): BackupInfo =>
	({ id, kind, createdAt: new Date(now.getTime() - age) }) as BackupInfo;

describe('kindFor', () => {
	test('a full backup when none is younger than fullEvery, incrementals apart', () => {
		expect(kindFor([], now, 7 * DAY)).toBe('full');
		expect(kindFor([made('incremental', DAY)], now, 7 * DAY)).toBe('full');
		expect(kindFor([made('full', 7 * DAY - 1)], now, 7 * DAY)).toBe(
			'incremental',
		);
		expect(kindFor([made('full', 7 * DAY)], now, 7 * DAY)).toBe('full');
	});
});

describe('chosenBackup', () => {
	test('an id as it is, a time as the newest at or before it, nothing as the newest', () => {
		const backups = [
			made('full', 2 * DAY, 'b'),
			made('full', 3 * DAY, 'a'),
			made('full', DAY, 'c'),
		];
		expect(chosenBackup(backups, 'z', 'w')).toBe('z');
		expect(chosenBackup(backups, undefined, 'w')).toBe('c');
		expect(chosenBackup(backups, new Date(now.getTime() - 2 * DAY), 'w')).toBe(
			'b',
		);
	});
});
