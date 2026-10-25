// What an app exports, defined and bound, behind exported values whose types
// are inferred: a declaration build must be able to name each one through
// `@nxgt/image` and `@nxgt/image/s3` alone (TS2883 otherwise).
import { defineImageSet, type ImageSet } from '@nxgt/image';
import { bindImageStore } from '@nxgt/image/s3';
import { bindBucket, defineBucket } from '@nxgt/s3';

export const avatars: ImageSet = defineImageSet({ sizes: [256, 64] });

export const inferred = defineImageSet();

export const avatarBucket = defineBucket({
	bucket: 'avatars',
	key: ({ imageId, size }: { imageId: string; size: number }) =>
		`avatars/${imageId}/${size}.webp`,
});

export const avatarStore = bindImageStore(
	avatars,
	bindBucket(avatarBucket, {
		accessKeyId: 'key',
		secretAccessKey: 'secret',
		endpoint: 'http://localhost:9000',
	}),
);

export const upload = (imageId: string, file: Blob) =>
	avatarStore.replace({ imageId }, file);

export const url = (imageId: string) => avatarStore.presignGet({ imageId }, 64);
