import ExcelJS from 'exceljs';
import { ApiError } from '../../lib/errors';
import { normalizePhone, encryptPhone, decryptPhone, sha256Hex, maskPhone, normalizeName } from '../../lib/crypto';
import { writeAudit } from '../../lib/audit';
import { paginatedResponse, parsePagination } from '../../lib/pagination';
import type { Db } from '../../lib/db';

export interface StudentInput {
  name: string;
  name_ur?: string | null;
  roll_no?: number | null;
  parent_name?: string | null;
  parent_phone?: string | null;
}

export function toPublicStudent(s: any): Record<string, unknown> {
  return {
    id: s.id,
    school_id: s.schoolId,
    class_id: s.classId,
    roll_no: s.rollNo ?? null,
    name: s.name,
    name_ur: s.nameUr ?? null,
    parent_name: s.parentName ?? null,
    parent_phone_masked: s.parentPhoneEnc ? maskPhone(decryptPhone(s.parentPhoneEnc)) : null,
    parent_has_phone: Boolean(s.parentPhoneEnc),
    parent_opt_out: s.parentOptOut,
    status: s.status,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

function parentPhoneFields(phone: string | null | undefined): { enc: string | null; hash: string | null } {
  if (!phone) return { enc: null, hash: null };
  const normalized = normalizePhone(phone);
  if (!normalized) throw ApiError.validation('Parent phone is not a valid Pakistani mobile number');
  return { enc: encryptPhone(normalized), hash: sha256Hex(normalized) };
}

async function assertClassInSchool(db: Db, schoolId: string, classId: string): Promise<any> {
  const c = await db.class.findFirst({ where: { id: classId, schoolId: schoolId } });
  if (!c) throw ApiError.notFound('Class not found');
  return c;
}

/** Duplicate rule (SCHEMA.md): same (class_id, name-normalized) OR same (school_id, phone_hash + name-normalized) is flagged, never silently merged. */
async function findDuplicate(
  db: Db,
  schoolId: string,
  classId: string,
  name: string,
  phoneHash: string | null,
  excludeId?: string,
): Promise<string | null> {
  const norm = normalizeName(name);
  const inClass = await db.student.findMany({ where: { classId: classId } });
  for (const s of inClass) {
    if (excludeId && s.id === excludeId) continue;
    if (normalizeName(s.name) === norm) return `A student named "${s.name}" already exists in this class`;
    if (phoneHash && s.parentPhoneHash === phoneHash && normalizeName(s.name) === norm) {
      return `A student named "${s.name}" with the same parent number already exists`;
    }
  }
  if (phoneHash) {
    const samePhone = await db.student.findMany({ where: { schoolId: schoolId, parentPhoneHash: phoneHash } });
    for (const s of samePhone) {
      if (excludeId && s.id === excludeId) continue;
      if (normalizeName(s.name) === norm) return `A student named "${s.name}" with the same parent number already exists in this school`;
    }
  }
  return null;
}

async function assertRollUnique(db: Db, classId: string, rollNo: number | null | undefined, excludeId?: string): Promise<void> {
  if (rollNo === null || rollNo === undefined) return;
  const existing = await db.student.findFirst({ where: { classId: classId, rollNo: rollNo } });
  if (existing && existing.id !== excludeId) {
    throw ApiError.conflict(`Roll number ${rollNo} is already used in this class`);
  }
}

export async function createStudent(db: Db, schoolId: string, classId: string, input: StudentInput, actorId?: string): Promise<any> {
  await assertClassInSchool(db, schoolId, classId);
  const phone = parentPhoneFields(input.parent_phone);
  const dup = await findDuplicate(db, schoolId, classId, input.name.trim(), phone.hash);
  if (dup) throw ApiError.conflict(dup);
  await assertRollUnique(db, classId, input.roll_no);
  const created = await db.student.create({
    data: {
      schoolId: schoolId,
      classId: classId,
      name: input.name.trim(),
      nameUr: input.name_ur?.trim() || null,
      rollNo: input.roll_no ?? null,
      parentName: input.parent_name?.trim() || null,
      parentPhoneEnc: phone.enc,
      parentPhoneHash: phone.hash,
      status: 'active',
    },
  });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'student.create', entity: 'student', entityId: created.id, details: { class_id: classId, name: created.name } });
  return created;
}

export async function listStudents(
  db: Db,
  schoolId: string,
  classId: string,
  query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  await assertClassInSchool(db, schoolId, classId);
  const { page, limit, skip } = parsePagination(query);
  const search = String(query.search ?? '').trim();
  const status = String(query.status ?? '').trim();
  const where: Record<string, unknown> = { schoolId: schoolId, classId: classId };
  if (status) where.status = status;
  const or: Record<string, unknown>[] = [];
  if (search) {
    or.push({ name: { contains: search, mode: 'insensitive' } });
    or.push({ parentName: { contains: search, mode: 'insensitive' } });
    const asNum = Number.parseInt(search, 10);
    if (!Number.isNaN(asNum)) or.push({ rollNo: asNum });
  }
  const whereWithSearch = or.length > 0 ? { ...where, OR: or } : where;
  const [items, total] = await Promise.all([
    db.student.findMany({ where: whereWithSearch, orderBy: [{ rollNo: 'asc' }, { name: 'asc' }], skip, take: limit }),
    db.student.count({ where: whereWithSearch }),
  ]);
  const pageOut = paginatedResponse(items.map(toPublicStudent), total, { page, limit, skip });
  return pageOut;
}

export async function getStudent(db: Db, schoolId: string, id: string): Promise<any> {
  const s = await db.student.findFirst({ where: { id, schoolId: schoolId } });
  if (!s) throw ApiError.notFound('Student not found');
  return s;
}

export async function updateStudent(db: Db, schoolId: string, id: string, patch: Partial<StudentInput & { status?: string; class_id?: string }>, actorId?: string): Promise<any> {
  const existing = await getStudent(db, schoolId, id);
  const targetClassId = patch.class_id ?? existing.classId;
  if (patch.class_id) await assertClassInSchool(db, schoolId, patch.class_id);
  const name = patch.name !== undefined ? patch.name.trim() : existing.name;
  let phoneHash = existing.parentPhoneHash as string | null;
  let phoneEnc = existing.parentPhoneEnc as string | null;
  if (patch.parent_phone !== undefined) {
    const phone = parentPhoneFields(patch.parent_phone);
    phoneEnc = phone.enc;
    phoneHash = phone.hash;
  }
  const dup = await findDuplicate(db, schoolId, targetClassId, name, phoneHash, id);
  if (dup) throw ApiError.conflict(dup);
  await assertRollUnique(db, targetClassId, patch.roll_no !== undefined ? patch.roll_no : existing.rollNo, id);
  const data: Record<string, unknown> = {
    name,
    classId: targetClassId,
    parentPhoneEnc: phoneEnc,
    parentPhoneHash: phoneHash,
  };
  if (patch.name_ur !== undefined) data.nameUr = patch.name_ur?.trim() || null;
  if (patch.roll_no !== undefined) data.rollNo = patch.roll_no ?? null;
  if (patch.parent_name !== undefined) data.parentName = patch.parent_name?.trim() || null;
  if (patch.status !== undefined) {
    if (!['active', 'left', 'graduated'].includes(patch.status)) throw ApiError.validation('Invalid status');
    data.status = patch.status;
  }
  const updated = await db.student.update({ where: { id }, data });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'student.update', entity: 'student', entityId: id, details: { name } });
  return updated;
}

export async function deleteStudent(db: Db, schoolId: string, id: string, actorId?: string): Promise<void> {
  const existing = await getStudent(db, schoolId, id);
  const [att, fees] = await Promise.all([
    db.attendanceRecord.count({ where: { studentId: id } }),
    db.feeRecord.count({ where: { studentId: id } }),
  ]);
  if (att > 0 || fees > 0) {
    throw ApiError.conflict('Cannot delete a student with attendance or fee history. Mark the student as "left" instead.');
  }
  await db.student.delete({ where: { id } });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'student.delete', entity: 'student', entityId: id, details: { name: existing.name } });
}

export async function updateParent(
  db: Db,
  schoolId: string,
  id: string,
  input: { parent_name?: string | null; parent_phone?: string | null; opt_out?: boolean },
  actorId?: string,
): Promise<any> {
  const existing = await getStudent(db, schoolId, id);
  const data: Record<string, unknown> = {};
  if (input.parent_name !== undefined) data.parentName = input.parent_name?.trim() || null;
  if (input.opt_out !== undefined) data.parentOptOut = input.opt_out;
  if (input.parent_phone !== undefined) {
    const phone = parentPhoneFields(input.parent_phone);
    data.parentPhoneEnc = phone.enc;
    data.parentPhoneHash = phone.hash;
  }
  const updated = await db.student.update({ where: { id }, data });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'student.parent_update', entity: 'student', entityId: id, details: { name: existing.name } });
  return updated;
}

/** Parents section: students whose parent numbers are missing / invalid / duplicated. */
export async function listParents(
  db: Db,
  schoolId: string,
  query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const flag = String(query.flag ?? '').trim();
  const all = await db.student.findMany({ where: { schoolId: schoolId, status: 'active' }, orderBy: [{ name: 'asc' }] });
  let filtered = all;
  if (flag === 'missing') {
    filtered = all.filter((s: any) => !s.parentPhoneEnc);
  } else if (flag === 'invalid') {
    filtered = all.filter((s: any) => s.parentPhoneEnc && !s.parentPhoneHash);
  } else if (flag === 'duplicate') {
    const seen = new Map<string, number>();
    for (const s of all) {
      if (!s.parentPhoneHash) continue;
      const key = `${s.parentPhoneHash}|${normalizeName(s.name)}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    filtered = all.filter((s: any) => {
      if (!s.parentPhoneHash) return false;
      return (seen.get(`${s.parentPhoneHash}|${normalizeName(s.name)}`) ?? 0) > 1;
    });
  }
  const total = filtered.length;
  const items = filtered.slice(skip, skip + limit).map(toPublicStudent);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

// ---------------------------------------------------------------------------
// Bulk import (CSV / Excel)
// ---------------------------------------------------------------------------

export interface ImportRow {
  name: string;
  name_ur?: string | null;
  roll_no?: number | null;
  parent_name?: string | null;
  parent_phone?: string | null;
}

export interface ImportResult {
  imported: number;
  duplicates_flagged: number;
  invalid_rows: Array<{ row: number; reason: string }>;
  saved_ids: string[];
}

/** Minimal RFC-4180 CSV parser (quoted fields, CRLF). */
export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      pushRow();
    } else if (ch === '\r') {
      // ignore, \n follows
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) pushRow();
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function rowsToImportRows(grid: string[][]): ImportRow[] {
  if (grid.length === 0) return [];
  const headers = grid[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const idx = (name: string): number => headers.indexOf(name);
  const out: ImportRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    const name = (r[idx('name')] ?? '').trim();
    if (!name) continue;
    const rollRaw = (r[idx('roll_no')] ?? '').trim();
    const rollNo = rollRaw === '' ? null : Number.parseInt(rollRaw, 10);
    out.push({
      name,
      name_ur: (r[idx('name_ur')] ?? '').trim() || null,
      roll_no: rollNo !== null && !Number.isNaN(rollNo) ? rollNo : null,
      parent_name: (r[idx('parent_name')] ?? '').trim() || null,
      parent_phone: (r[idx('parent_phone')] ?? '').trim() || null,
    });
  }
  return out;
}

export async function parseXlsxBuffer(buf: Buffer): Promise<ImportRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const grid: string[][] = [];
  ws.eachRow((row) => {
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      values.push(cell.text ?? '');
    });
    grid.push(values);
  });
  return rowsToImportRows(grid);
}

export async function importStudents(
  db: Db,
  schoolId: string,
  classId: string,
  rows: ImportRow[],
  actorId?: string,
): Promise<ImportResult> {
  await assertClassInSchool(db, schoolId, classId);
  const result: ImportResult = { imported: 0, duplicates_flagged: 0, invalid_rows: [], saved_ids: [] };
  const seenNames = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNo = i + 2; // 1-based incl. header
    if (!row.name || !row.name.trim()) {
      result.invalid_rows.push({ row: rowNo, reason: 'Missing student name' });
      continue;
    }
    const norm = normalizeName(row.name);
    if (seenNames.has(norm)) {
      result.duplicates_flagged += 1;
      continue;
    }
    seenNames.add(norm);
    let phoneHash: string | null = null;
    let phoneEnc: string | null = null;
    if (row.parent_phone) {
      const normalized = normalizePhone(row.parent_phone);
      if (!normalized) {
        result.invalid_rows.push({ row: rowNo, reason: `Invalid parent phone: ${row.parent_phone}` });
        continue;
      }
      phoneEnc = encryptPhone(normalized);
      phoneHash = sha256Hex(normalized);
    }
    const dup = await findDuplicate(db, schoolId, classId, row.name.trim(), phoneHash);
    if (dup) {
      result.duplicates_flagged += 1;
      continue;
    }
    if (row.roll_no !== null && row.roll_no !== undefined) {
      const rollUsed = await db.student.findFirst({ where: { classId: classId, rollNo: row.roll_no } });
      if (rollUsed) {
        result.invalid_rows.push({ row: rowNo, reason: `Roll number ${row.roll_no} already exists in this class` });
        continue;
      }
    }
    const created = await db.student.create({
      data: {
        schoolId: schoolId,
        classId: classId,
        name: row.name.trim(),
        nameUr: row.name_ur || null,
        rollNo: row.roll_no ?? null,
        parentName: row.parent_name || null,
        parentPhoneEnc: phoneEnc,
        parentPhoneHash: phoneHash,
        status: 'active',
      },
    });
    result.imported += 1;
    result.saved_ids.push(created.id);
  }
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'student.import', entity: 'class', entityId: classId, details: { imported: result.imported, duplicates: result.duplicates_flagged, invalid: result.invalid_rows.length } });
  return result;
}
