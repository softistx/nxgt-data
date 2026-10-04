// What the types refuse, each pinned by an @ts-expect-error that fails the
// typecheck the day the refusal stops compiling as one.
import type { BackupSource, RestoreTarget } from '@nxgt/backup';
import type { Db } from 'mongodb';
import {
	MongoBackupError,
	type MongoBackupErrorCode,
	mongoSource,
	mongoTarget,
	type Restorer,
	restoreCollections,
} from '../../src/index';

declare const db: Db;

// What they make is what @nxgt/backup takes.
const source: BackupSource = mongoSource({ db });
const target: RestoreTarget = mongoTarget({ db, replace: true });
mongoSource({ db, collections: ['a', 'b'] });
mongoSource({ db, collections: (name) => name.startsWith('app.') });
mongoTarget({ db, tmpDir: '/var/tmp' });

// @ts-expect-error — a source needs its database
mongoSource({});
// @ts-expect-error — a database, not its name
mongoSource({ db: 'app' });
// @ts-expect-error — collections are names, or a test on each name
mongoSource({ db, collections: 'a' });
// @ts-expect-error — a test takes a name
mongoSource({ db, collections: (n: number) => n > 0 });
// @ts-expect-error — a target needs its database
mongoTarget({ replace: true });
// @ts-expect-error — replace is a yes or a no
mongoTarget({ db, replace: 'drop' });

const code: MongoBackupErrorCode = new MongoBackupError('m', 'EXISTS').code;
// @ts-expect-error — a code is one of those listed
new MongoBackupError('m', 'NOPE');

void [source, target, code];

// restoreCollections: replace is for whole collections, and documents says what happens to those there.
declare const restorer: Restorer;
restoreCollections(restorer, 'id', {
	identities: [],
	db,
	// @ts-expect-error replace has no meaning with documents: the pair is refused
	documents: { filter: {}, existing: 'keep' },
	replace: true,
});
restoreCollections(restorer, 'id', {
	identities: [],
	db,
	// @ts-expect-error existing is required: a document already there is replaced or kept, never by default
	documents: { filter: {} },
});
restoreCollections(restorer, 'id', {
	identities: [],
	db,
	// @ts-expect-error existing is 'replace' or 'keep'
	documents: { filter: {}, existing: 'merge' },
});
restoreCollections(restorer, 'id', { identities: [], db, replace: true });
