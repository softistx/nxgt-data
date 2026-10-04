// What the types refuse, each pinned by an @ts-expect-error that fails the
// typecheck the day the refusal stops compiling as one.
import {
	type BackupSource,
	bindBackup,
	defineBackup,
	directorySource,
	directoryTarget,
	generateSigningKeys,
	localRepository,
	s3Repository,
} from '../../src/index';

const app = defineBackup({ name: 'app' });
const repository = localRepository({ path: '/var/backups' });
const recipient = 'age1…';
const source: BackupSource = directorySource({ path: '/srv/uploads' });
const target = directoryTarget({ path: '/srv/restore' });

// @ts-expect-error — a repository needs its folder
localRepository({});
// @ts-expect-error — an S3 repository needs Bun's client
s3Repository({});
// @ts-expect-error — and not just any object
s3Repository({ client: {} });
// @ts-expect-error — a source needs its folder
directorySource({});
// @ts-expect-error — a target needs its folder
directoryTarget({ overwrite: true });

// @ts-expect-error — a definition needs a name
defineBackup({});
// @ts-expect-error — the name is a string
defineBackup({ name: 1 });

// @ts-expect-error — at least one repository
bindBackup(app, { repositories: [], recipients: [recipient] });
// @ts-expect-error — at least one recipient
bindBackup(app, { repositories: [repository], recipients: [] });
// @ts-expect-error — recipients are strings
bindBackup(app, { repositories: [repository], recipients: [1] });

const backups = bindBackup(app, {
	repositories: [repository],
	recipients: [recipient],
});

// @ts-expect-error — create takes a source, not a path
backups.create('/srv/uploads');
void backups.create(source);

// @ts-expect-error — a restore needs the identities that open it
backups.restore('id', target, {});
// @ts-expect-error — identities are a list, not one key
backups.restore('id', target, { identities: 'AGE-SECRET-KEY-1…' });
// @ts-expect-error — only is names or a test on a name
backups.restore('id', target, { identities: ['k'], only: 1 });
void backups.restore('id', target, { identities: ['k'], only: ['a.txt'] });
void backups.restore('id', target, {
	identities: ['k'],
	only: (n) => n.endsWith('.txt'),
});

// @ts-expect-error — identities are a list here too
backups.verify('id', { identities: 'AGE-SECRET-KEY-1…' });
void backups.verify('id');
void backups.verify('id', { from: undefined, identities: undefined });

const signing = generateSigningKeys();
bindBackup(app, {
	repositories: [repository],
	recipients: [recipient],
	// @ts-expect-error — signing takes the key under `key`, not the key itself
	signing: signing.privateKey,
});
bindBackup(app, {
	repositories: [repository],
	recipients: [recipient],
	// @ts-expect-error — signing needs its key
	signing: {},
});
bindBackup(app, {
	repositories: [repository],
	recipients: [recipient],
	// @ts-expect-error — at least one trusted key, when trusted is given
	trusted: [],
});
bindBackup(app, {
	repositories: [repository],
	recipients: [recipient],
	// @ts-expect-error — trusted is a list, not one key
	trusted: signing.publicKey,
});
bindBackup(app, {
	repositories: [repository],
	recipients: [recipient],
	signing: { key: signing.privateKey },
	trusted: [signing.publicKey],
});
bindBackup(app, {
	repositories: [repository],
	recipients: [recipient],
	lock: { lease: 60_000 },
});
bindBackup(app, {
	repositories: [repository],
	recipients: [recipient],
	// @ts-expect-error — a lease is milliseconds, not a duration string
	lock: { lease: '5m' },
});

// The name is kept as a literal.
const named: 'app' = backups.definition.name;
void named;
