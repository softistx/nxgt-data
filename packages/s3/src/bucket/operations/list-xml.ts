import { s3Error } from './fetch-object';

/**
 * What a ListObjectsV2 answer says, read without an XML parser: the answer is
 * flat and S3's own, and a key can hold anything, so the text is unescaped
 * once and only after it has been cut out.
 */

export interface ListedObject {
	key: string;
	size: number | undefined;
	lastModified: string | undefined;
	eTag: string | undefined;
}

export interface ListAnswer {
	contents: ListedObject[];
	isTruncated: boolean;
	nextContinuationToken: string | undefined;
}

const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
};

/** What XML 1.0 allows as a character: not 0, nor most controls, nor lone surrogates. */
const allowed = (code: number): boolean =>
	code === 0x9 ||
	code === 0xa ||
	code === 0xd ||
	(code >= 0x20 && code <= 0xd7ff) ||
	(code >= 0xe000 && code <= 0xfffd) ||
	(code >= 0x10000 && code <= 0x10ffff);

const malformed = () =>
	s3Error(
		'InvalidResponse',
		'',
		'ListObjectsV2 response is not a well-formed <ListBucketResult> document',
	);

/** One pass, so `&amp;lt;` is `&lt;` and not `<`. A reference XML forbids is a malformed answer. */
function unescapeXml(text: string): string {
	return text.replace(
		/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
		(whole, name: string) => {
			if (!name.startsWith('#')) return ENTITIES[name.toLowerCase()] ?? whole;
			const code =
				name[1] === 'x' || name[1] === 'X'
					? Number.parseInt(name.slice(2), 16)
					: Number.parseInt(name.slice(1), 10);
			if (!allowed(code)) throw malformed();
			return String.fromCodePoint(code);
		},
	);
}

/** Text with its CDATA sections as they are, and the rest unescaped. */
function textOf(raw: string): string {
	return raw
		.split(/<!\[CDATA\[([\s\S]*?)\]\]>/)
		.map((part, at) => (at % 2 ? part : unescapeXml(part)))
		.join('');
}

function field(xml: string, tag: string): string | undefined {
	const found = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1];
	return found === undefined ? undefined : textOf(found);
}

/** The root must be a `ListBucketResult`, after an optional XML declaration. */
const ROOT = /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?<ListBucketResult[\s>]/;

export function parseListing(xml: string): ListAnswer {
	if (!ROOT.test(xml)) throw malformed();
	const contents: ListedObject[] = [];
	// Everything outside the `<Contents>` blocks: a key that spells a tag is
	// escaped, but cutting the blocks out first means it is never looked at.
	const rest = xml.replace(
		/<Contents>([\s\S]*?)<\/Contents>/g,
		(_, entry: string) => {
			const size = field(entry, 'Size');
			contents.push({
				key: field(entry, 'Key') ?? '',
				size:
					size !== undefined && Number.isFinite(Number(size))
						? Number(size)
						: undefined,
				lastModified: field(entry, 'LastModified'),
				eTag: field(entry, 'ETag'),
			});
			return '';
		},
	);
	return {
		contents,
		isTruncated: field(rest, 'IsTruncated') === 'true',
		nextContinuationToken: field(rest, 'NextContinuationToken'),
	};
}
