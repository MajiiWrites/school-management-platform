/**
 * Parent-portal inbox (Messaging Center, 2026-11-20).
 *
 * Parents open their tokenized portal link and see the messages the school
 * sent about their child — absent alerts, fee reminders, custom messages —
 * plus school announcements, as one inbox list. Same token rules as the
 * portal itself: one token shows exactly ONE student, revoked/expired
 * tokens see nothing.
 *
 * Read state is persisted in parent_message_reads (migration
 * 20261120030000): one row per (token, item). The inbox lists every sent
 * message with its date and channel, plus `read` per item. Delivery
 * honesty is preserved: a WhatsApp row shows "Opened in WhatsApp"
 * (delivery status 'opened'), never "delivered".
 */
import { ApiError } from '../../lib/errors';
import type { Db } from '../../lib/db';
import { resolveParentToken } from '../portal/service';

export interface PortalInboxItem {
  id: string;
  kind: 'message' | 'announcement';
  /** SMS | WhatsApp | Email (messages only). */
  channel?: 'SMS' | 'WhatsApp' | 'Email';
  type?: string;
  title?: string | null;
  body: string;
  sent_at: string;
  /** Latest delivery status ('sent' | 'opened' | 'failed' | 'pending'). */
  delivery_status?: string;
  /** True once this token has marked the item read (Messages tab). */
  read?: boolean;
}

export interface PortalInbox {
  school: { name: string };
  student: { id: string; name: string; class_name: string };
  messages: PortalInboxItem[];
}

function channelOf(provider: string | null | undefined): 'SMS' | 'WhatsApp' | 'Email' {
  if (provider === 'whatsapp') return 'WhatsApp';
  if (provider === 'email') return 'Email';
  return 'SMS';
}

export async function getPortalInbox(db: Db, token: string): Promise<PortalInbox> {
  const resolved = await resolveParentToken(db, token);
  if (!resolved) throw ApiError.notFound('This parent link is invalid, revoked or expired');
  const { student, school } = resolved;

  const cls: any = await (db as any).class.findFirst({
    where: { id: student.classId, schoolId: school.id },
  });
  const classLabel = cls ? `${cls.name}-${cls.section}` : '—';

  // Sent messages about THIS student only (queued/failed rows are not
  // shown — a parent sees only what actually left the school).
  const rows: any[] = await (db as any).messageQueue.findMany({
    where: { schoolId: school.id, studentId: student.id, status: 'sent' },
    orderBy: [{ createdAt: 'desc' }],
    take: 50,
  });
  const ids = rows.map((r: any) => r.id);
  const deliveryRows: any[] = ids.length
    ? await (db as any).messageDelivery.findMany({
        where: { queueId: { in: ids } },
        orderBy: [{ createdAt: 'desc' }],
      })
    : [];
  const latestByQueue = new Map<string, any>();
  for (const d of deliveryRows) {
    if (!latestByQueue.has(d.queueId)) latestByQueue.set(d.queueId, d);
  }

  const announcements: any[] = await (db as any).announcement.findMany({
    where: { schoolId: school.id, status: { in: ['approved', 'sent'] } },
    orderBy: [{ createdAt: 'desc' }],
    take: 10,
  });

  // Read marks for this token only (a token never sees another token's
  // read state — reads are keyed by tokenId).
  const readRows: any[] = await (db as any).parentMessageRead.findMany({
    where: { tokenId: (resolved.row as any).id },
  });
  const readKeys = new Set(readRows.map((r: any) => `${r.itemKind}:${r.itemId}`));

  const items: PortalInboxItem[] = [
    ...rows.map((r: any) => {
      const d = latestByQueue.get(r.id);
      return {
        id: r.id,
        kind: 'message' as const,
        channel: channelOf(d?.provider ?? null),
        type: r.type,
        body: r.body,
        sent_at: (r.sentAt ?? r.createdAt).toISOString(),
        delivery_status: d?.status ?? 'sent',
        read: readKeys.has(`message:${r.id}`),
      };
    }),
    ...announcements
      .filter((a: any) => a.targetType === 'all' || !a.targetClassId || a.targetClassId === student.classId)
      .map((a: any) => ({
        id: a.id,
        kind: 'announcement' as const,
        title: a.title,
        body: a.body,
        sent_at: new Date(a.createdAt).toISOString(),
        read: readKeys.has(`announcement:${a.id}`),
      })),
  ];
  items.sort((a, b) => +new Date(b.sent_at) - +new Date(a.sent_at));

  return {
    school: { name: school.name },
    student: { id: student.id, name: student.name, class_name: classLabel },
    messages: items,
  };
}

/**
 * Mark inbox items read for one token. Only items that belong to this
 * token's student are marked — foreign ids are skipped silently (a
 * read-mark is not an error path). Re-marking is a no-op (unique
 * (tokenId, itemKind, itemId)). Returns how many rows were newly marked.
 */
export async function markPortalInboxRead(
  db: Db,
  token: string,
  items: { kind: string; id: string }[],
): Promise<{ marked: number }> {
  const resolved = await resolveParentToken(db, token);
  if (!resolved) throw ApiError.notFound('This parent link is invalid, revoked or expired');
  const { student, school } = resolved;
  const tokenId = (resolved.row as any).id as string;

  const valid = items.filter(
    (it) => (it.kind === 'message' || it.kind === 'announcement') && typeof it.id === 'string' && it.id.length > 0,
  );
  if (valid.length === 0) return { marked: 0 };

  const owned: { kind: string; id: string }[] = [];
  for (const it of valid) {
    if (it.kind === 'message') {
      const row: any = await (db as any).messageQueue.findFirst({
        where: { id: it.id, schoolId: school.id, studentId: student.id },
      });
      if (row) owned.push(it);
    } else {
      const row: any = await (db as any).announcement.findFirst({
        where: { id: it.id, schoolId: school.id },
      });
      if (row && (row.targetType === 'all' || !row.targetClassId || row.targetClassId === student.classId)) {
        owned.push(it);
      }
    }
  }
  if (owned.length === 0) return { marked: 0 };

  const res: any = await (db as any).parentMessageRead.createMany({
    data: owned.map((it) => ({
      schoolId: school.id,
      tokenId,
      studentId: student.id,
      itemKind: it.kind,
      itemId: it.id,
    })),
    skipDuplicates: true,
  });
  return { marked: res?.count ?? 0 };
}
