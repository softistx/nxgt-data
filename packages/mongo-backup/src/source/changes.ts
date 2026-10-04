import type { ChangeStream, Db, Document, Timestamp } from 'mongodb';
import { MongoBackupError, serverCode } from '../errors';
import { EXACT, writeChange } from '../format/change';
import type { Resume } from '../format/position';
import type { CollectionFilter } from './collections';
import { changeOf, type Event, followed, passedOver } from './events';

/** The server cannot resume the stream there: its history is gone. */
const HISTORY_LOST = new Set([286, 280]);

function lost(error: unknown): unknown {
	return HISTORY_LOST.has(serverCode(error) ?? 0)
		? new MongoBackupError(
				'mongoSource: the change stream cannot resume where the last backup ' +
					'stopped: the oplog no longer reaches back there; make a full backup',
				'HISTORY_LOST',
				{ cause: error },
			)
		: error;
}

/**
 * The changes since `from`, up to the operation time `until`, to the
 * collections `held` names — brought up to date as they come — as
 * concatenated BSON, then `record` with where the next backup resumes.
 * The stream stops at the first event after `until`, at an invalidation,
 * or once a read of the change stream comes back empty — caught up.
 */
export function changesOf(
	db: Db,
	from: Resume,
	held: Set<string>,
	until: Timestamp,
	filter: CollectionFilter | undefined,
	record: (resume: Resume) => void,
): ReadableStream<Uint8Array> {
	let stream: ChangeStream | undefined;
	let resume = from;
	const finish = async (controller: ReadableStreamDefaultController) => {
		await stream?.close();
		record(resume);
		controller.close();
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				stream ??= db.watch([], {
					...from,
					fullDocument: 'whenAvailable',
					showExpandedEvents: true,
					...EXACT,
				});
				for (;;) {
					const event = (await stream.tryNext()) as Event | null;
					// An empty read: the stream has caught up with now, past `until`.
					if (event === null) {
						resume = { startAfter: stream.resumeToken as Document };
						return await finish(controller);
					}
					if (event.operationType === 'invalidate') {
						resume = { startAfter: event._id as Document };
						return await finish(controller);
					}
					if (event.clusterTime?.greaterThan(until)) {
						return await finish(controller);
					}
					resume = { startAfter: event._id as Document };
					if (passedOver(event, held, filter)) continue;
					const change = changeOf(event, db.databaseName);
					const kept = change && followed(change, held, filter);
					if (kept) {
						controller.enqueue(writeChange(kept));
						return;
					}
				}
			} catch (error) {
				await stream?.close().catch(() => undefined);
				controller.error(lost(error));
			}
		},
		async cancel() {
			await stream?.close();
		},
	});
}
