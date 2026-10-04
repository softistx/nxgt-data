const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Whether `path` is a relative path of plain segments — letters, digits,
 * `.`, `_`, `-`, none of them `.` or `..` — that every repository can hold
 * under the same name, and none can climb out of.
 */
export function isKeyPath(path: string): boolean {
	return path
		.split('/')
		.every(
			(segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..',
		);
}
