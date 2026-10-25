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
