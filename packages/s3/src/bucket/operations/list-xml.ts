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

/** One pass, so `&amp;lt;` is `&lt;` and not `<`. */
function unescapeXml(text: string): string {
	return text.replace(
		/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
		(whole, name: string) => {
			if (!name.startsWith('#')) return ENTITIES[name.toLowerCase()] ?? whole;
			const code =
				name[1] === 'x' || name[1] === 'X'
					? Number.parseInt(name.slice(2), 16)
					: Number.parseInt(name.slice(1), 10);
			return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		},
	);
}

function field(xml: string, tag: string): string | undefined {
	const found = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1];
	return found === undefined ? undefined : unescapeXml(found);
}

export function parseListing(xml: string): ListAnswer {
	const contents: ListedObject[] = [];
	// Everything outside the `<Contents>` blocks: a key that spells a tag is
	// escaped, but cutting the blocks out first means it is never looked at.
	const rest = xml.replace(
		/<Contents>([\s\S]*?)<\/Contents>/g,
		(_, entry: string) => {
			const size = field(entry, 'Size');
			contents.push({
				key: field(entry, 'Key') ?? '',
				size: size === undefined ? undefined : Number(size),
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
