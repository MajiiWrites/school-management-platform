// Live-DB probe seed (SCRATCH DB ONLY — never the live Render DB).
// Creates two schools (Alpha / Beta) with one class + student each, a fee
// structure + records, 6 message templates each, one held queue row each,
// one SMS device each, and a teacher-link token for Alpha's class.
// Run via live-cross-tenant.sh; prints the seeded ids as JSON for the probe.
import { PrismaClient } from '@prisma/client';
import { encryptPhone, sha256Hex, hashToken, randomToken } from '../../lib/crypto';
import { DEFAULT_TEMPLATES } from '../../modules/messaging/templates';

const DAY = '2026-11-06';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const mkSchool = async (name: string, slug: string) =>
      prisma.school.create({ data: { name, slug, timezone: 'Asia/Karachi', country: 'PK', settings: {} } });
    const schoolA = await mkSchool('Live Alpha School', 'live-alpha-probe');
    const schoolB = await mkSchool('Live Beta School', 'live-beta-probe');
    const adminA = await prisma.user.create({ data: { schoolId: schoolA.id, email: 'admin@live-alpha.test', passwordHash: 'x', role: 'admin', emailVerified: true } });
    const adminB = await prisma.user.create({ data: { schoolId: schoolB.id, email: 'admin@live-beta.test', passwordHash: 'x', role: 'admin', emailVerified: true } });

    const mkClass = async (schoolId: string, name: string, section: string) =>
      prisma.class.create({
        data: {
          schoolId, name, section, teacherName: `Teacher ${name}-${section}`,
          teacherPhoneEnc: encryptPhone('+923001111111'), teacherPhoneHash: sha256Hex('+923001111111'),
        },
      });
    const classA = await mkClass(schoolA.id, '5', 'A');
    const classB = await mkClass(schoolB.id, '5', 'A');

    const mkStudent = async (schoolId: string, classId: string, name: string, phone: string) =>
      prisma.student.create({
        data: {
          schoolId, classId, rollNo: 1, name, parentName: `Parent of ${name}`,
          parentPhoneEnc: encryptPhone(phone), parentPhoneHash: sha256Hex(phone), status: 'active',
        },
      });
    const stuA = await mkStudent(schoolA.id, classA.id, 'Live Ahmed Raza', '+923001111111');
    const stuB = await mkStudent(schoolB.id, classB.id, 'Live Bilal Ahmed', '+923002222222');

    for (const school of [schoolA, schoolB]) {
      for (const type of ['absent', 'fee_reminder', 'teacher_reminder'] as const) {
        for (const language of ['en', 'ur'] as const) {
          await prisma.messageTemplate.create({
            data: { schoolId: school.id, type, language, body: (DEFAULT_TEMPLATES as any)[type][language], isActive: true },
          });
        }
      }
      await prisma.feeStructure.create({
        data: { schoolId: school.id, classId: school.id === schoolA.id ? classA.id : classB.id, monthlyAmount: 2500, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
      });
    }
    await prisma.feeRecord.create({
      data: { schoolId: schoolA.id, studentId: stuA.id, month: '2026-11', amountDue: 2500, amountPaid: 2500, discount: 0, receiptNo: 'live-alpha-202611-001', paymentMethod: 'cash', paidAt: new Date('2026-11-02T00:00:00Z') },
    });
    await prisma.feeRecord.create({
      data: { schoolId: schoolB.id, studentId: stuB.id, month: '2026-11', amountDue: 2500, amountPaid: 0, discount: 0 },
    });
    const qA = await prisma.messageQueue.create({
      data: { schoolId: schoolA.id, type: 'absent', studentId: stuA.id, classId: classA.id, parentPhoneEnc: encryptPhone('+923001111111'), body: 'Live Ahmed Raza absent', status: 'queued', dedupeKey: `absent:${stuA.id}:${DAY}`, scheduledFor: new Date(`${DAY}T09:00:00Z`) },
    });
    const qB = await prisma.messageQueue.create({
      data: { schoolId: schoolB.id, type: 'absent', studentId: stuB.id, classId: classB.id, parentPhoneEnc: encryptPhone('+923002222222'), body: 'Live Bilal Ahmed absent', status: 'queued', dedupeKey: `absent:${stuB.id}:${DAY}`, scheduledFor: new Date(`${DAY}T09:00:00Z`) },
    });
    await prisma.smsDevice.create({ data: { schoolId: schoolA.id, deviceId: 'live-dev-a1', name: 'Alpha phone' } });
    await prisma.smsDevice.create({ data: { schoolId: schoolB.id, deviceId: 'live-dev-b1', name: 'Beta phone' } });
    await prisma.ocrUpload.create({ data: { schoolId: schoolA.id, classId: classA.id, filePath: '/tmp/live-a.png', status: 'review', rawText: '1. Live Ahmed Raza' } });
    const token = randomToken(32);
    await prisma.class.update({
      where: { id: classA.id },
      data: { attendanceTokenHash: hashToken(token), tokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), tokenRevoked: false },
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      schoolA: schoolA.id, schoolB: schoolB.id,
      adminA: adminA.id, adminB: adminB.id,
      classA: classA.id, classB: classB.id,
      stuA: stuA.id, stuB: stuB.id,
      queueA: qA.id, queueB: qB.id,
      token,
    }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
