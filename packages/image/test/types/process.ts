// What `process` and `defineImageSet` refuse. Checked by `tsc --noEmit`, never run.
import type { ImageInput } from '../../src';
import { ImageError } from '../../src';
import { defineImageSet } from '../../src/set/define-image-set';

const set = defineImageSet({ sizes: [64] });

// An input is bytes, a buffer, a Blob or a stream: not a path.
// @ts-expect-error a string is not an image input
set.process('a path');

// @ts-expect-error a crop needs x, y and size
set.process(new Uint8Array(), { crop: { x: 0, y: 0 } });

// @ts-expect-error a crop is { x, y, size }, not a width and a height
set.process(new Uint8Array(), { crop: { x: 0, y: 0, width: 1, height: 1 } });

// @ts-expect-error sizes is a list of sides, not one number
defineImageSet({ sizes: 64 });

// @ts-expect-error a size is a number
defineImageSet({ sizes: ['64'] });

// @ts-expect-error an option the set does not have
defineImageSet({ width: 64 });

// @ts-expect-error `process` takes no option but `crop`
set.process(new Uint8Array(), { quality: 10 });

// What is accepted, so a refusal above is the cause and not a broken import.
set.process(new Uint8Array(), { crop: { x: 0, y: 0, size: 1 } });
set.process(new Blob([]));

// The input type is exported, and a Uint8Array and a Blob are inputs.
const inputs: ImageInput[] = [new Uint8Array(), new Blob([])];
// @ts-expect-error a number is not an image input
const notAnInput: ImageInput = 1;

// The error codes and reasons are closed lists.
new ImageError('INVALID_CROP', 'crop');
// @ts-expect-error a code the package does not have
new ImageError('BAD_CROP', 'crop');
// @ts-expect-error a reason the package does not have
new ImageError('INVALID_CROP', 'shape');
void inputs;
void notAnInput;
