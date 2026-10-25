// What `bindImageStore` refuses. Checked by `tsc --noEmit`, never run.
import { bindBucket, defineBucket } from '@nxgt/s3';
import { bindImageStore } from '../../src/s3';
import { defineImageSet } from '../../src/set/define-image-set';

const set = defineImageSet();
const sized = bindBucket(
	defineBucket({
		bucket: 'images',
		key: ({ imageId, size }: { imageId: string; size: number }) =>
			`${imageId}/${size}.webp`,
	}),
);
const store = bindImageStore(set, sized);

// The params are the key's, minus the size.
const key: string = store.keyFor({ imageId: 'a' }, 64);
void key;

const unsized = bindBucket(
	defineBucket({ bucket: 'x', key: (p: { imageId: string }) => p.imageId }),
);

// @ts-expect-error the bucket's key has no `size`
bindImageStore(set, unsized);

// @ts-expect-error `imageId` is missing
store.keyFor({}, 64);

// @ts-expect-error `size` is an argument, never part of the params
store.keyFor({ imageId: 'a', size: 64 }, 64);

const wide = bindBucket(
	defineBucket({
		bucket: 'x',
		key: (p: { imageId: string; size: string }) => `${p.imageId}/${p.size}`,
	}),
);

// @ts-expect-error a `size` that is a string is not the set's number
bindImageStore(set, wide);

const optional = bindBucket(
	defineBucket({
		bucket: 'x',
		key: (p: { imageId: string; size?: number }) =>
			`${p.imageId}/${p.size ?? 0}`,
	}),
);

// @ts-expect-error an optional `size` is not required, so the bucket may be called without it
bindImageStore(set, optional);

// @ts-expect-error `imageId` is missing
store.replace({}, new Uint8Array());

// @ts-expect-error a number is not an upload
store.replace({ imageId: 'a' }, 42);

// @ts-expect-error `imageId` is missing
store.remove({});

// @ts-expect-error `imageId` is a string
store.remove({ imageId: 1 });
