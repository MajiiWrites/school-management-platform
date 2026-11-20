// Parent-portal inbox read state (Messaging Center wiring, 2026-11-20):
// inbox items carry `read`, marking is idempotent, and a token can only
// mark its own student's items. In-memory fake Db, same conventions as
// modules/portal/portal.test.ts.
import { describe, it, expect } from 'vitest';
import { getPortalInbox, markPortalInboxRead } from '../portal-inbox';
import { hashToken } from '../../../lib/crypto';

const TOKEN = 'raw-token-1';
const OTHER_TOKEN = 'raw-token-2';

function fakeDb() {
  const schools: any[] = [
    { id: 'school-1', name: 'Test School', slug: 'test-school', timezone: 'Asia/Karachi' },
  ];
  const classes: any[] = [
    { id: 'class-1', schoolId: 'school-1', name: '5', section: 'A', teacherName: 'Miss Sana', deletedAt: null },
  ];
  const students: any[] = [
    { id: 'stu-1', schoolId: 'school-1', classId: 'class-1', name: 'Ayesha Khan', status: 'active', deletedAt: null },
    { id: 'stu-2', schoolId: 'school-1', classId: 'class-1', name: 'Bilal Ahmed', status: 'active', deletedAt: null },
  ];
  const parentTokens: any[] = [
    { id: 'tok-1', schoolId: 'school-1', studentId: 'stu-1', tokenHash: hashToken(TOKEN), tokenEnc: 'enc-1', expiresAt: new Date(Date.now() + 86400000), revoked: false },
    { id: 'tok-2', schoolId: 'school-1', studentId: 'stu-2', tokenHash: hashToken(OTHER_TOKEN), tokenEnc: 'enc-2', expiresAt: new Date(Date.now() + 86400000), revoked: false },
  ];
  const messageQueue: any[] = [
    { id: 'q-1', schoolId: 'school-1', studentId: 'stu-1', type: 'absent', body: 'Ayesha was absent today.', status: 'sent', sentAt: new Date('2026-11-19T08:00:00Z'), createdAt: new Date('2026-11-19T08:00:00Z') },
    { id: 'q-2', schoolId: 'school-1', studentId: 'stu-1', type: 'custom', body: 'Still queued — not shown.', status: 'queued', sentAt: null, createdAt: new Date('2026-11-19T09:00:00Z') },
    { id: 'q-3', schoolId: 'school-1', studentId: 'stu-2', type: 'absent', body: 'Bilal was absent today.', status: 'sent', sentAt: new Date('2026-11-19T08:00:00Z'), createdAt: new Date('2026-11-19T08:00:00Z') },
  ];
  const messageDeliveries: any[] = [
    { id: 'd-1', queueId: 'q-1', provider: 'whatsapp', status: 'opened', createdAt: new Date('2026-11-19T08:05:00Z') },
  ];
  const announcements: any[] = [
    { id: 'ann-1', schoolId: 'school-1', title: 'PTM on Friday', body: 'Parent-teacher meeting', targetType: 'all', targetClassId: null, status: 'approved', createdAt: new Date('2026-11-18T00:00:00Z') },
    { id: 'ann-2', schoolId: 'school-1', title: 'Other class only', body: 'not for 5-A', targetType: 'class', targetClassId: 'class-other', status: 'approved', createdAt: new Date('2026-11-18T00:00:00Z') },
  ];
  const reads: any[] = [];
  let seq = 1;
  const id = () => `id-${seq++}`;

  const norm = (v: any) => (v instanceof Date ? v.getTime() : v);
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]) => {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        if ('in' in (v as any)) return (v as any).in.map(norm).includes(norm(row[k]));
        if ('not' in (v as any)) return (v as any).not === null ? row[k] != null : norm(row[k]) !== norm((v as any).not);
      }
      if (v === null) return row[k] == null;
      return norm(row[k]) === norm(v);
    });
  const sortBy = (rows: any[], orderBy: any): any[] => {
    let out = [...rows];
    for (const o of (Array.isArray(orderBy) ? orderBy : [orderBy])) {
      const [k, dir] = Object.entries(o)[0] as [string, string];
      out = out.sort((a, b) => (norm(a[k]) < norm(b[k]) ? -1 : norm(a[k]) > norm(b[k]) ? 1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    return out;
  };
  const collection = (rows: any[]) => ({
    findFirst: async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
    findMany: async ({ where, orderBy, take }: any) => {
      const out = rows.filter((r) => matches(r, where));
      const sorted = orderBy ? sortBy(out, orderBy) : out;
      return typeof take === 'number' ? sorted.slice(0, take) : sorted;
    },
    create: async ({ data }: any) => {
      const row = { id: id(), createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    createMany: async ({ data, skipDuplicates }: any) => {
      let count = 0;
      for (const d of data) {
        const dup = rows.some(
          (r) => r.tokenId === d.tokenId && r.itemKind === d.itemKind && r.itemId === d.itemId,
        );
        if (dup && skipDuplicates) continue;
        rows.push({ id: id(), readAt: new Date(), ...d });
        count += 1;
      }
      return { count };
    },
  });

  const db: any = {
    school: collection(schools),
    class: collection(classes),
    student: collection(students),
    parentToken: collection(parentTokens),
    messageQueue: collection(messageQueue),
    messageDelivery: collection(messageDeliveries),
    announcement: collection(announcements),
    parentMessageRead: collection(reads),
    __reads: reads,
    __parentTokens: parentTokens,
  };
  return db;
}

describe('portal inbox read state', () => {
  it('inbox items start unread, and marking them flips read to true', async () => {
    const db = fakeDb();
    const before = await getPortalInbox(db as any, TOKEN);
    expect(before.messages).toHaveLength(2); // q-1 + ann-1 (queued q-2 hidden, other-class ann-2 hidden)
    expect(before.messages.every((m) => m.read === false)).toBe(true);
    expect(before.messages.find((m) => m.id === 'q-1')?.channel).toBe('WhatsApp');
    expect(before.messages.find((m) => m.id === 'q-1')?.delivery_status).toBe('opened');

    const res = await markPortalInboxRead(db as any, TOKEN, [
      { kind: 'message', id: 'q-1' },
      { kind: 'announcement', id: 'ann-1' },
    ]);
    expect(res.marked).toBe(2);

    const after = await getPortalInbox(db as any, TOKEN);
    expect(after.messages.every((m) => m.read === true)).toBe(true);
  });

  it('re-marking is a no-op (unique token+kind+id)', async () => {
    const db = fakeDb();
    await markPortalInboxRead(db as any, TOKEN, [{ kind: 'message', id: 'q-1' }]);
    const again = await markPortalInboxRead(db as any, TOKEN, [{ kind: 'message', id: 'q-1' }]);
    expect(again.marked).toBe(0);
    expect(db.__reads).toHaveLength(1);
  });

  it('a token cannot mark another student’s items (foreign ids skipped, never an error)', async () => {
    const db = fakeDb();
    const res = await markPortalInboxRead(db as any, TOKEN, [
      { kind: 'message', id: 'q-3' }, // Bilal's message
      { kind: 'announcement', id: 'ann-2' }, // other-class announcement
      { kind: 'bogus', id: 'q-1' }, // invalid kind
      { kind: 'message', id: 'does-not-exist' },
    ]);
    expect(res.marked).toBe(0);
    expect(db.__reads).toHaveLength(0);
    // And the other token's inbox is unaffected.
    const other = await getPortalInbox(db as any, OTHER_TOKEN);
    expect(other.messages.find((m) => m.id === 'q-3')?.read).toBe(false);
  });

  it('a revoked token gets 404 on both inbox and mark', async () => {
    const db = fakeDb();
    db.__parentTokens[0].revoked = true;
    await expect(getPortalInbox(db as any, TOKEN)).rejects.toMatchObject({ status: 404 });
    await expect(markPortalInboxRead(db as any, TOKEN, [{ kind: 'message', id: 'q-1' }])).rejects.toMatchObject({
      status: 404,
    });
  });
});
