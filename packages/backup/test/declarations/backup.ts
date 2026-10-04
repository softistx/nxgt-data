// What an app exports, defined and bound, behind exported values whose types
// are inferred: a declaration build must be able to name each one through
// `@nxgt/backup` alone (TS2883 otherwise).
import {
	bindBackup,
	defineBackup,
	directorySource,
	directoryTarget,
	localRepository,
} from '@nxgt/backup';

export const appBackup = defineBackup({ name: 'app' });

export const repository = localRepository({ path: '/var/backups/app' });

export const backups = bindBackup(appBackup, {
	repositories: [repository],
	recipients: [
		'age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq',
	],
});

export const uploads = directorySource({ path: '/srv/uploads' });

export const restoreInto = directoryTarget({ path: '/srv/restore' });

export const nightly = () => backups.create(uploads);

export const latest = async () => (await backups.list()).backups.at(-1);
