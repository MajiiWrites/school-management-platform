// Live-DB cross-tenant probes (SCRATCH DB ONLY — never the live Render DB).
// Reads the seed JSON from live-seed.ts on stdin and runs the REAL service
// functions + the REAL Prisma messaging store against the live scratch DB,
// acting as School B against School A's rows. Exits 0 only if every probe
// passes; prints one PASS/FAIL line per probe.
import { getDb } from '../../lib/db';
import * as classesSvc from '../classes/service';
import * as studentsSvc from '../students/service';
import * as feesSvc from '../fees/service';
import * as adminSvc from '../admin/service';
import * as attendanceSvc from '../attendance/service';
import * as reportsSvc from '../reports/service';
import { getJobsStatus } from '../../jobs/registry';
import { createPrismaMessagingStore } from '../messaging/store';
import { approveMessages, getDeviceQueue } from '../messaging/service';
import { prismaOcrDb } from '../ocr/prisma-adapter';

interface Seed {
  schoolA: string; schoolB: string;
  adminA: string; adminB: string;
  classA: string; classB: string;
  stuA: string; stuB: string;
  queueA: string; queueB: string;
  token: string;
}

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
async function rejectsWithCode(name: string, p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
    check(name, false, 'succeeded, expected rejection');
  } catch (err: any) {
    check(name, err?.code === code, `got code ${err?.code ?? err?.message}`);
  }
}

async function main(): Promise<void> {
  const seed: Seed = JSON.parse(process.argv[2]);
  const db = getDb();
  const A = seed.schoolA;
  const B = seed.schoolB;
  const store = createPrismaMessagingStore(db as any);

  // --- classes / students (live rows) ---
  await rejectsWithCode('live: B cannot read A class', classesSvc.getClass(db, B, seed.classA), 'NOT_FOUND');
  await rejectsWithCode('live: B cannot update A class', classesSvc.updateClass(db, B, seed.classA, { teacher_name: 'Hijacked' }), 'NOT_FOUND');
  await rejectsWithCode('live: B cannot read A student', studentsSvc.getStudent(db, B, seed.stuA), 'NOT_FOUND');
  const search = await studentsSvc.listStudents(db, B, seed.classB, { search: 'Live Ahmed Raza' });
  check('live: B searching A student name finds nothing', search.total === 0, `total=${search.total}`);
  const parents = await studentsSvc.listParents(db, B, {});
  check('live: B parents list has no A student', parents.items.every((s: any) => s.school_id === B), `n=${parents.total}`);

  // --- fees / receipts ---
  await rejectsWithCode('live: B cannot pay A student', feesSvc.payFee(db, B, seed.stuA, { month: '2026-11', amount_paid: 100 }, seed.adminB), 'NOT_FOUND');
  await rejectsWithCode('live: B cannot fetch A receipt', feesSvc.getReceiptByNo(db, B, 'live-alpha-202611-001'), 'NOT_FOUND');
  const fees = await feesSvc.listFees(db, B, { month: '2026-11' }, 'Asia/Karachi');
  check('live: B fee list has no A student', fees.items.every((i) => i.student_name !== 'Live Ahmed Raza'), `n=${fees.total}`);
  const report = await feesSvc.monthlyFeeReport(db, B, '2026-11');
  check('live: B fee report collected excludes A payment', report.collected === 0, `collected=${report.collected}`);

  // --- dashboard / reports ---
  const dash = await adminSvc.getDashboard(db, B);
  check('live: B dashboard classes_total is B only', dash.classes_total === 1, `classes_total=${dash.classes_total}`);
  const daily = await reportsSvc.attendanceDaily(db, B, { date: '2026-11-06', class_id: seed.classA });
  check('live: B attendance report for A class is empty', (daily as any).by_class.length === 0, '');

  // --- teacher token with a school context ---
  const resolvedWrong = await classesSvc.resolveLinkToken(db, seed.token, B);
  check('live: A token resolves to null for B school context', resolvedWrong === null, '');
  const resolvedRight = await classesSvc.resolveLinkToken(db, seed.token, A);
  check('live: A token resolves for A school context', resolvedRight !== null && resolvedRight.id === seed.classA, '');
  await rejectsWithCode('live: B cannot open A link page with school context', attendanceSvc.getLinkPage(db, seed.token, B), 'NOT_FOUND');

  // --- messaging store (real Prisma adapter) ---
  const namesForB = await store.getStudentsByIds([seed.stuA, seed.stuB], B);
  check('live: store student lookup scoped to B', namesForB.length === 1 && namesForB[0].id === seed.stuB, JSON.stringify(namesForB));
  const qForB = await store.findQueueByDedupeKey(`absent:${seed.stuA}:2026-11-06`, B);
  check('live: store dedupe lookup scoped to B', qForB === null, '');
  const qRowForB = await store.getQueueById(seed.queueA, B);
  check('live: store queue lookup scoped to B', qRowForB === null, '');
  const tplA = await db.messageTemplate.findFirst({ where: { schoolId: A } });
  const tplForB = tplA ? await store.getTemplateById(tplA.id, B) : 'missing-seed';
  check('live: store template lookup for A template is null for B', tplForB === null, '');
  const approved = await approveMessages(
    { store, now: () => new Date('2026-11-06T09:00:00Z') },
    { schoolId: B, approvedBy: seed.adminB, dedupeKeys: [`absent:${seed.stuA}:2026-11-06`] },
  );
  check("live: B approving A's draft approves 0", approved.approved === 0, `approved=${approved.approved}`);
  const qAAfter = await store.getQueueById(seed.queueA, A);
  check("live: A's draft still unapproved after B attempt", qAAfter?.approvedAt === null, '');
  try {
    await store.upsertDevice({ schoolId: B, deviceId: 'live-dev-a1', name: 'Stolen' });
    check('live: B stealing A device_id conflicts', false, 'upsert succeeded');
  } catch (err: any) {
    check('live: B stealing A device_id conflicts', err?.code === 'CONFLICT', `got ${err?.code}`);
  }
  try {
    await getDeviceQueue({ store, now: () => new Date() }, { schoolId: B, deviceId: 'live-dev-a1' });
    check("live: B polling with A's device is rejected", false, 'poll succeeded');
  } catch (err: any) {
    check("live: B polling with A's device is rejected", err?.code === 'NOT_FOUND', `got ${err?.code}`);
  }

  // --- OCR adapter (real Prisma adapter) ---
  const ocrDb = prismaOcrDb(db as any);
  const upA = await db.ocrUpload.findFirst({ where: { schoolId: A } });
  if (!upA) {
    check('live: OCR upload seeded for A', false, 'no upload row');
  } else {
    check('live: OCR getUpload scoped to B is null', (await ocrDb.getUpload(B, upA.id)) === null, '');
    try {
      await ocrDb.updateUpload(B, upA.id, { status: 'saved' });
      check('live: OCR updateUpload scoped to B is rejected', false, 'update succeeded');
    } catch (err: any) {
      check('live: OCR updateUpload scoped to B is rejected', err?.status === 404, `got ${err?.status}`);
    }
    const after = await db.ocrUpload.findFirst({ where: { id: upA.id } });
    check("live: A's OCR upload untouched by B", after?.status === 'review', `status=${after?.status}`);
  }

  // --- jobs status ---
  const jobs = await getJobsStatus(db, B);
  check('live: jobs status scoped to B lists only B', jobs.jobs.every((j) => j.schools.length === 1 && j.schools[0].school_id === B), '');

  // --- positive controls: B can still use its own data ---
  const ownClass = await classesSvc.getClass(db, B, seed.classB);
  check('live: B can read its own class', ownClass.id === seed.classB, '');
  const ownReceipt = await feesSvc.payFee(db, B, seed.stuB, { month: '2026-11', amount_paid: 2500, payment_method: 'cash' }, seed.adminB);
  check('live: B can pay its own student', ownReceipt.student_name === 'Live Bilal Ahmed', ownReceipt.receipt_no);

  const failed = results.filter((r) => !r.pass);
  // eslint-disable-next-line no-console
  console.log(`\nLIVE PROBE: ${results.length - failed.length}/${results.length} passed`);
  await db.$disconnect();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
