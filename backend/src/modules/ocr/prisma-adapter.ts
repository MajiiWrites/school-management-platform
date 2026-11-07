// Maps a PrismaClient onto the narrow OcrDb interface the service needs.
// Keeps the service unit-testable (fake OcrDb) while the real path uses Prisma.
//
// INTEGRATION (Phase 3): the model/field names below are the REAL generated
// client names from backend/prisma/schema.prisma (singular camelCase models,
// camelCase fields). The OcrDb interface itself keeps its snake_case shapes
// (service + tests use them); this adapter translates at the boundary:
// Prisma camelCase rows -> OcrDb snake_case records on the way out,
// OcrDb snake_case inputs -> Prisma camelCase on the way in.
import type { OcrDb, UploadRecord } from './service.js';

/** Minimal structural type for the Prisma client subset this module uses. */
export interface PrismaLike {
  class: {
    findFirst(args: { where: { id: string; schoolId: string } }): Promise<{ id: string } | null>;
  };
  student: {
    findMany(args: {
      where: { schoolId: string; classId: string; deletedAt: null };
      select: { name: true; rollNo: true; parentPhoneHash: true };
    }): Promise<{ name: string; rollNo: number | null; parentPhoneHash: string | null }[]>;
    createMany(args: {
      data: {
        schoolId: string;
        classId: string;
        name: string;
        nameUr: string | null;
        rollNo: number | null;
        parentName: string | null;
        parentNameUr: string | null;
        parentPhoneEnc: string | null;
        parentPhoneHash: string | null;
      }[];
      skipDuplicates?: boolean;
    }): Promise<{ count: number }>;
  };
  ocrUpload: {
    create(args: { data: { schoolId: string; classId: string; filePath: string; status: string } }): Promise<{ id: string }>;
    findFirst(args: { where: { id: string; schoolId: string } }): Promise<{
      id: string;
      schoolId: string;
      classId: string;
      filePath: string;
      status: string;
      rawText: string | null;
      resultJson: string | null;
    } | null>;
    update(args: { where: { id: string }; data: { status?: string; rawText?: string; resultJson?: string } }): Promise<unknown>;
  };
  auditLog: {
    create(args: { data: { schoolId: string; actorId: string | null; actorType: string; action: string; entity: string; entityId: string | null; details: object } }): Promise<unknown>;
  };
}

function toUploadRecord(r: {
  id: string;
  schoolId: string;
  classId: string;
  filePath: string;
  status: string;
  rawText: string | null;
  resultJson: string | null;
}): UploadRecord {
  return {
    id: r.id,
    school_id: r.schoolId,
    class_id: r.classId,
    file_path: r.filePath,
    status: r.status as UploadRecord['status'],
    raw_text: r.rawText,
    result_json: r.resultJson,
  };
}

export function prismaOcrDb(prisma: PrismaLike): OcrDb {
  return {
    async getClass(schoolId, classId) {
      return prisma.class.findFirst({ where: { id: classId, schoolId } });
    },
    async listStudents(schoolId, classId) {
      // R2-D (b): exclude soft-deleted students — the old query had no
      // deletedAt filter, so a student sitting in the Recycle Bin still
      // flagged every re-uploaded row with their name/roll as "Duplicate?",
      // and the only escape was permanent deletion. Every other student
      // list query filters deletedAt: null (schema comment on Student).
      const rows = await prisma.student.findMany({
        where: { schoolId, classId, deletedAt: null },
        select: { name: true, rollNo: true, parentPhoneHash: true },
      });
      return rows.map((r) => ({ name: r.name, roll_no: r.rollNo, parent_phone_hash: r.parentPhoneHash }));
    },
    async createUpload(data) {
      return prisma.ocrUpload.create({
        data: { schoolId: data.school_id, classId: data.class_id, filePath: data.file_path, status: 'processing' },
      });
    },
    async getUpload(schoolId, uploadId) {
      const row = await prisma.ocrUpload.findFirst({ where: { id: uploadId, schoolId } });
      return row ? toUploadRecord(row) : null;
    },
    async updateUpload(schoolId, uploadId, data) {
      // ISOLATION FIX: the old code updated by id alone, so any caller
      // holding another school's upload id could overwrite its status /
      // raw_text. Verify ownership first (scoped read), then update.
      const owned = await prisma.ocrUpload.findFirst({ where: { id: uploadId, schoolId } });
      if (!owned) {
        const err = new Error('OCR upload not found') as Error & { status?: number; code?: string };
        err.status = 404; err.code = 'NOT_FOUND';
        throw err;
      }
      const updateData: { status?: string; rawText?: string; resultJson?: string } = {};
      if (data.status !== undefined) updateData.status = data.status;
      if (data.raw_text !== undefined) updateData.rawText = data.raw_text;
      if (data.result_json !== undefined) updateData.resultJson = data.result_json;
      await prisma.ocrUpload.update({ where: { id: uploadId }, data: updateData });
    },
    async createStudents(schoolId, classId, rows) {
      const res = await prisma.student.createMany({
        data: rows.map((r) => ({
          schoolId,
          classId,
          name: r.name,
          nameUr: r.name_ur,
          rollNo: r.roll_no,
          parentName: r.parent_name ?? null,
          parentNameUr: r.parent_name_ur ?? null,
          parentPhoneEnc: r.parent_phone_enc,
          parentPhoneHash: r.parent_phone_hash,
        })),
        skipDuplicates: true,
      });
      return { created: res.count };
    },
    async getUploadFile(schoolId, uploadId) {
      const row = await prisma.ocrUpload.findFirst({ where: { id: uploadId, schoolId } });
      return row ? { file_path: row.filePath } : null;
    },
    async createAuditLog(entry) {
      await prisma.auditLog.create({
        data: {
          schoolId: entry.school_id,
          actorId: entry.actor_id,
          actorType: entry.actor_type,
          action: entry.action,
          entity: entry.entity,
          entityId: entry.entity_id,
          details: entry.details,
        },
      });
    },
  };
}
