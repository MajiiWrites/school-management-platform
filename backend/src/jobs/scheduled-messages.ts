// Scheduled custom messages (Section 11).
//
// Picks up due 'scheduled' message_drafts and sends them — but ONLY when
// an approved approval_requests row exists for the draft. A scheduled
// draft without approval stays scheduled and is reported, never sent.
// Sends go through the existing message_queue (custom-messages service) —
// this job never sends SMS itself. Idempotent: a sent draft has status
// 'sent', and the queue dedupe `custom:{draftId}:{studentId}` is the
// backstop, so a tick that runs twice is harmless.

import type { Db } from '../lib/db';
import { createPrismaMessagingStore } from '../modules/messaging/store';
import { processDueScheduledDrafts } from '../modules/messaging/custom-messages';
import type { SchoolRow } from './common';

export interface ScheduledMessagesResult {
  job: 'scheduled_messages';
  ran: boolean;
  reason?: string;
  school_id: string;
  checked: number;
  sent: number;
  skipped_unapproved: number;
  errors: Array<{ draftId: string; error: string }>;
}

export async function runScheduledMessages(
  db: Db,
  school: SchoolRow,
  now: Date = new Date(),
): Promise<ScheduledMessagesResult> {
  const store = createPrismaMessagingStore(db as any);
  const result = await processDueScheduledDrafts(
    { store, now: () => now },
    { schoolId: school.id },
  );
  return {
    job: 'scheduled_messages',
    ran: result.checked > 0,
    reason: result.checked === 0 ? 'no due scheduled drafts' : undefined,
    school_id: school.id,
    checked: result.checked,
    sent: result.sent,
    skipped_unapproved: result.skippedUnapproved,
    errors: result.errors,
  };
}
