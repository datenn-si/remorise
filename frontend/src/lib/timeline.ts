import type { DisplayMessage, MemorySearchDebug, StateAnalysis } from '../types/chat';
import type { DebugJob, DebugSummary } from '../types/debug';

/**
 * Debug-mode timeline layout. A turn renders as:
 *
 *   user message
 *   front-stage block   (one row: keywords, search hits/recalls, and
 *                        the emotion/mood/affinity the front stage set)
 *   assistant reply     (token usage and tool calls ride on the reply
 *                        itself as its generation breakdown)
 *   pipeline block      (one row, only when something actually ran for
 *                        the turn: summary jobs, a created summary)
 *
 * Data sources (all pre-existing records, nothing new is stored):
 * - a turn's assistant message metadata: state_analysis and
 *   memory_search (the front stage's records) and summary. These are
 *   authoritative for a completed turn.
 * - the user message's front_stage record: the same front-stage event
 *   from the other side. Used only when the turn never produced a
 *   reply (dangling), where no assistant-side record exists, so the
 *   event appears exactly once either way.
 * - the debug jobs API: a job is attached as a whole (registration
 *   and, once finished, its outcome) to the pipeline block of the
 *   turn that was current when it was registered. Jobs not tied to
 *   any turn (an idle flush firing between turns, work predating the
 *   visible history) form pipeline blocks at their time position.
 * - summaries appear twice, on purpose, with a division of roles:
 *   the creation event in the creating turn's pipeline block is
 *   metadata only (id, covered range, creation time — no body),
 *   while the summary itself stands as a collapsed row right after
 *   the last message of its covered range, carrying body and
 *   metadata. Summarization decides the model's context only; it
 *   never removes the messages it covers from the history, so the
 *   timeline keeps them and places the summary where its range ends.
 *   When the range's end is not among the loaded messages (an older
 *   page not fetched yet, or rows the display folds away), the row
 *   lands just before the oldest loaded message newer than the
 *   range. Superseded summaries (replaced as the context grew) and
 *   invalidated ones (their whole range forgotten) stand here too,
 *   marked with their state; neither ever comes back into use.
 *   The set comes from the assistant metadata records joined by id
 *   with the debug history API's summary rows, which carry body,
 *   time, and lifecycle state.
 */
export type FrontStageBlock = {
  analysis: StateAnalysis | null;
  keywords: string[];
  search: MemorySearchDebug | null;
};

export type PipelineItem =
  | { type: 'summary'; summary: TimelineSummary }
  | { type: 'job_registered'; job: DebugJob }
  | { type: 'job_finished'; job: DebugJob };

export type TimelineSummary = {
  id: number;
  start_message_id: number;
  end_message_id: number;
  /** Body text from the debug history API; null when unavailable. */
  content: string | null;
  /** Creation time from the debug history API; null when unavailable. */
  created_at: string | null;
  /** Still the summary the context uses (false once superseded). */
  active: boolean;
  /** Invalidated by forgetting: its whole range left the conversation. */
  archived: boolean;
};

export type TimelineEntry =
  | { type: 'message'; id: string; message: DisplayMessage }
  | { type: 'front'; id: string; block: FrontStageBlock }
  | { type: 'pipeline'; id: string; items: PipelineItem[] }
  | { type: 'summary'; id: string; summary: TimelineSummary };

type Slot =
  | { kind: 'entry'; entry: TimelineEntry }
  | { kind: 'pipeline'; id: string; items: PipelineItem[] };

export function buildTimeline(
  messages: DisplayMessage[],
  jobs: DebugJob[],
  summaries: DebugSummary[] = [],
): TimelineEntry[] {
  const slots: Slot[] = [];
  // Pipeline buckets keyed by the slot they follow, so background jobs
  // can be attached after the message walk has placed every message.
  const bucketAfterMessage = new Map<string, Extract<Slot, { kind: 'pipeline' }>>();
  let leadingBucket: Extract<Slot, { kind: 'pipeline' }> | null = null;

  const newBucket = (id: string): Extract<Slot, { kind: 'pipeline' }> => ({
    kind: 'pipeline',
    id,
    items: [],
  });

  // History rows by summary id: they carry the body, creation time,
  // and lifecycle state that the metadata records lack. Every row
  // counts — superseded and invalidated summaries stay visible in
  // the debug timeline at their range position.
  const historyById = new Map<number, DebugSummary>();
  for (const row of summaries) {
    historyById.set(row.id, row);
  }
  const joinSummary = (record: {
    id: number;
    start_message_id: number;
    end_message_id: number;
  }): TimelineSummary => {
    const row = historyById.get(record.id);
    return {
      id: record.id,
      start_message_id: row?.start_message_id ?? record.start_message_id,
      end_message_id: row?.end_message_id ?? record.end_message_id,
      content: row?.content ?? null,
      created_at: row?.created_at ?? null,
      active: row?.active ?? true,
      archived: row?.archived ?? false,
    };
  };

  let lastUser: DisplayMessage | undefined;
  for (const message of messages) {
    if (message.role === 'assistant') {
      const front = frontBlockFor(message, lastUser);
      if (front)
        slots.push({
          kind: 'entry',
          entry: { type: 'front', id: `front-${message.id}`, block: front },
        });
    }
    slots.push({ kind: 'entry', entry: { type: 'message', id: message.id, message } });
    if (message.role === 'user') {
      lastUser = message;
      // Dangling turn: no reply was ever saved, so there is no
      // assistant-side record; surface the front stage from the user
      // message's own record, where the reply would have followed.
      if (message.dangling && message.frontStage) {
        slots.push({
          kind: 'entry',
          entry: {
            type: 'front',
            id: `front-${message.id}`,
            block: {
              analysis: message.frontStage,
              keywords: message.frontStage.keywords,
              search: null,
            },
          },
        });
      }
    } else {
      // Every completed turn owns a pipeline bucket, seeded with the
      // creation event of the summary it made (time joined from the
      // history row; the block renders metadata only). Empty buckets
      // are dropped when flattening, so quiet turns show nothing.
      const bucket = newBucket(`pipeline-${message.id}`);
      if (message.summary) {
        bucket.items.push({ type: 'summary', summary: joinSummary(message.summary) });
      }
      slots.push(bucket);
      bucketAfterMessage.set(message.id, bucket);
    }
  }

  // Attach each job, as a whole, to the turn that was current at its
  // registration time: the last message at or before that moment. A
  // user message resolves to its turn's reply bucket; with no reply
  // (or no message at all yet) the job forms its own block there.
  const orderedJobs = [...jobs].sort((a, b) =>
    a.created_at === b.created_at ? a.id - b.id : a.created_at < b.created_at ? -1 : 1,
  );
  for (const job of orderedJobs) {
    let owner: DisplayMessage | undefined;
    for (const message of messages) {
      if (message.createdAt !== undefined && message.createdAt <= job.created_at) owner = message;
    }
    let bucket: Extract<Slot, { kind: 'pipeline' }>;
    if (owner === undefined) {
      if (!leadingBucket) {
        leadingBucket = newBucket('pipeline-leading');
        slots.unshift(leadingBucket);
      }
      bucket = leadingBucket;
    } else if (owner.role === 'assistant') {
      bucket = bucketAfterMessage.get(owner.id)!;
    } else {
      const replyIndex = messages.indexOf(owner) + 1;
      const reply = messages[replyIndex];
      if (reply?.role === 'assistant') {
        bucket = bucketAfterMessage.get(reply.id)!;
      } else {
        let own = bucketAfterMessage.get(owner.id);
        if (!own) {
          own = newBucket(`pipeline-${owner.id}`);
          slots.splice(
            slots.findIndex((slot) => slot.kind === 'entry' && slot.entry.id === owner.id) + 1,
            0,
            own,
          );
          bucketAfterMessage.set(owner.id, own);
        }
        bucket = own;
      }
    }
    bucket.items.push({ type: 'job_registered', job });
    if (job.status === 'done' || job.status === 'failed') {
      bucket.items.push({ type: 'job_finished', job });
    }
  }

  const withSummaries = insertSummaries(
    slots,
    collectSummaries(messages, historyById, joinSummary),
  );
  const entries: TimelineEntry[] = [];
  for (const slot of withSummaries) {
    if (slot.kind === 'entry') entries.push(slot.entry);
    else if (slot.items.length > 0)
      entries.push({ type: 'pipeline', id: slot.id, items: slot.items });
  }
  return entries;
}

/**
 * The full summary set: the union of the debug history rows and the
 * creation records on assistant messages (a record whose history row
 * is missing still counts), ordered by covered range.
 */
function collectSummaries(
  messages: DisplayMessage[],
  historyById: Map<number, DebugSummary>,
  joinSummary: (record: {
    id: number;
    start_message_id: number;
    end_message_id: number;
  }) => TimelineSummary,
): TimelineSummary[] {
  const byId = new Map<number, TimelineSummary>();
  for (const row of historyById.values()) {
    byId.set(row.id, joinSummary(row));
  }
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.summary) continue;
    if (byId.has(message.summary.id)) continue;
    byId.set(message.summary.id, joinSummary(message.summary));
  }
  return [...byId.values()].sort(
    (a, b) =>
      a.end_message_id - b.end_message_id || a.start_message_id - b.start_message_id || a.id - b.id,
  );
}

function serverIdOf(displayId: string): number | null {
  const match = /^msg-(\d+)$/.exec(displayId);
  return match ? Number(match[1]) : null;
}

function slotOwnerId(slot: Slot): number | null {
  if (slot.kind === 'pipeline') {
    return slot.id.startsWith('pipeline-') ? serverIdOf(slot.id.slice('pipeline-'.length)) : null;
  }
  if (slot.entry.type === 'message') return serverIdOf(slot.entry.message.id);
  if (slot.entry.type === 'front') {
    return slot.entry.id.startsWith('front-')
      ? serverIdOf(slot.entry.id.slice('front-'.length))
      : null;
  }
  return null;
}

/**
 * Place each summary right after the slot of the last loaded message
 * its range covers (the turn's pipeline bucket travels with its
 * message). When no loaded message falls inside or before the range
 * — the range sits in an older page not fetched yet — the summary
 * goes just before the first loaded message entry instead, which is
 * the oldest loaded message newer than the range.
 */
function insertSummaries(slots: Slot[], summaries: TimelineSummary[]): Slot[] {
  if (summaries.length === 0) return slots;
  const byPosition = new Map<number, TimelineSummary[]>();
  for (const summary of summaries) {
    let position = -1;
    for (let index = slots.length - 1; index >= 0; index -= 1) {
      const owner = slotOwnerId(slots[index]);
      if (owner !== null && owner <= summary.end_message_id) {
        position = index + 1;
        break;
      }
    }
    if (position === -1) {
      const firstMessage = slots.findIndex(
        (slot) => slot.kind === 'entry' && slot.entry.type === 'message',
      );
      position = firstMessage === -1 ? slots.length : firstMessage;
    }
    const group = byPosition.get(position) ?? [];
    group.push(summary);
    byPosition.set(position, group);
  }
  const merged: Slot[] = [];
  for (let index = 0; index <= slots.length; index += 1) {
    for (const summary of byPosition.get(index) ?? []) {
      merged.push({
        kind: 'entry',
        entry: { type: 'summary', id: `summary-${summary.id}`, summary },
      });
    }
    if (index < slots.length) merged.push(slots[index]);
  }
  return merged;
}

function frontBlockFor(
  reply: DisplayMessage,
  lastUser: DisplayMessage | undefined,
): FrontStageBlock | null {
  if (!reply.stateAnalysis && !reply.memorySearch) return null;
  return {
    analysis: reply.stateAnalysis ?? null,
    // The keywords are the terms of the searches the front stage
    // ran, flattened in order; the user message's own record is the
    // fallback for turns whose search record is missing.
    keywords: reply.memorySearch
      ? [...new Set(reply.memorySearch.searches.flatMap((search) => search.terms))]
      : (lastUser?.frontStage?.keywords ?? []),
    search: reply.memorySearch ?? null,
  };
}
