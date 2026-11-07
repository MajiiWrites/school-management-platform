import ExcelJS from 'exceljs';
import { ApiError } from '../../lib/errors';
import { normalizePhone, encryptPhone, decryptPhone, sha256Hex, maskPhone, normalizeName } from '../../lib/crypto';
import { writeAudit } from '../../lib/audit';
import { writeChangeLogs, logCreate, softDeleteEntity, isUniqueViolation } from '../hardening/helpers';
import { paginatedResponse, parsePagination } from '../../lib/pagination';
import type { Db } from '../../lib/db';

export interface StudentInput {
  name: string;
  name_ur?: string | null;
  roll_no?: number | null;
  parent_name?: string | null;
  parent_name_ur?: string | null;
  parent_phone?: string | null;
  parent_opt_out?: boolean;
  // v2 extended profile (contracts/SCHEMA.md §1)
  father_name?: string | null;
  admission_no?: string | null;
  date_of_birth?: string | null;
  gender?: string | null;
  address?: string | null;
  admission_date?: string | null;
  parent2_name?: string | null;
  parent2_phone?: string | null;
  parent2_opt_out?: boolean;
}

function toISODate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return new Date(d).toISOString().slice(0, 10);
}

export function toPublicStudent(s: any): Record<string, unknown> {
  // A row whose phone cannot be decrypted (e.g. the encryption key was
  // rotated) used to throw and 500 the whole student list. Show it as
  // unmasked instead — the phone_flag logic below still reports it.
  let parentMasked: string | null = null;
  let parent2Masked: string | null = null;
  let parentDecryptFailed = false;
  try {
    parentMasked = s.parentPhoneEnc ? maskPhone(decryptPhone(s.parentPhoneEnc)) : null;
  } catch {
    parentMasked = null;
    parentDecryptFailed = true;
  }
  try {
    parent2Masked = s.parent2PhoneEnc ? maskPhone(decryptPhone(s.parent2PhoneEnc)) : null;
  } catch {
    parent2Masked = null;
  }
  // D2: the list used to return neither `parent_phone` nor `phone_flag`,
  // so the Students table read `parent_phone` (always undefined → "—")
  // while the badge fell through to green "OK" — phones were stored fine
  // (encrypted) but never displayed. `parent_phone` here is the MASKED
  // value (never the full number); it is the alias the frontend type
  // (`parent_phone // masked in responses`) and mock data already expect.
  // 'duplicate' is NOT set here — a per-row serializer cannot see
  // siblings; the list functions upgrade it via duplicateFlagIds
  // (whole class/school scope, so pagination cannot hide a pair).
  const phoneFlag: 'missing' | 'invalid' | null = !s.parentPhoneEnc
    ? 'missing'
    : !s.parentPhoneHash || parentDecryptFailed
      ? 'invalid'
      : null;
  return {
    id: s.id,
    school_id: s.schoolId,
    class_id: s.classId,
    roll_no: s.rollNo ?? null,
    name: s.name,
    name_ur: s.nameUr ?? null,
    parent_name: s.parentName ?? null,
    parent_name_ur: s.parentNameUr ?? null,
    parent_phone: parentMasked,
    parent_phone_masked: parentMasked,
    parent_has_phone: Boolean(s.parentPhoneEnc),
    phone_flag: phoneFlag,
    parent_opt_out: s.parentOptOut,
    status: s.status,
    father_name: s.fatherName ?? null,
    admission_no: s.admissionNo ?? null,
    date_of_birth: toISODate(s.dateOfBirth),
    gender: s.gender ?? null,
    address: s.address ?? null,
    admission_date: toISODate(s.admissionDate),
    parent2_name: s.parent2Name ?? null,
    parent2_phone_masked: parent2Masked,
    parent2_opt_out: s.parent2OptOut ?? false,
    id_card_issued_at: s.idCardIssuedAt ?? null,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

/**
 * Display-safe view of a student row for change_logs: phones are masked
 * (ciphertext / hashes must never land in change history).
 */
function changeView(s: any): Record<string, unknown> {
  return {
    name: s.name,
    name_ur: s.nameUr ?? null,
    roll_no: s.rollNo ?? null,
    class_id: s.classId,
    parent_name: s.parentName ?? null,
    parent_phone: s.parentPhoneEnc ? maskPhone(decryptPhone(s.parentPhoneEnc)) : null,
    parent_opt_out: s.parentOptOut,
    status: s.status,
    father_name: s.fatherName ?? null,
    admission_no: s.admissionNo ?? null,
    date_of_birth: toISODate(s.dateOfBirth),
    gender: s.gender ?? null,
    address: s.address ?? null,
    admission_date: toISODate(s.admissionDate),
    parent2_name: s.parent2Name ?? null,
    parent2_phone: s.parent2PhoneEnc ? maskPhone(decryptPhone(s.parent2PhoneEnc)) : null,
    parent2_opt_out: s.parent2OptOut ?? false,
  };
}

function parentPhoneFields(phone: string | null | undefined): { enc: string | null; hash: string | null } {
  if (!phone) return { enc: null, hash: null };
  const normalized = normalizePhone(phone);
  if (!normalized) throw ApiError.validation('Parent phone is not a valid Pakistani mobile number');
  return { enc: encryptPhone(normalized), hash: sha256Hex(normalized) };
}

async function assertClassInSchool(db: Db, schoolId: string, classId: string): Promise<any> {
  const c = await db.class.findFirst({ where: { id: classId, schoolId: schoolId, deletedAt: null } });
  if (!c) throw ApiError.notFound('Class not found');
  return c;
}

/**
 * D1: same trap as classes — the DB unique indexes (classId, rollNo) and
 * (schoolId, admissionNo) do NOT exclude soft-deleted rows, while the
 * app-layer checks do. A re-add that collides with a deleted student
 * surfaced as a bare P2002 ("A record with these values already exists").
 * Point at the Recycle Bin instead.
 */
async function throwStudentUniqueConflict(
  db: Db,
  schoolId: string,
  classId: string,
  rollNo: number | null | undefined,
  admissionNo: string | null | undefined,
): Promise<never> {
  if (rollNo !== null && rollNo !== undefined) {
    const deleted = await db.student.findFirst({ where: { schoolId: schoolId, classId: classId, rollNo: rollNo, deletedAt: { not: null } } });
    if (deleted) {
      throw ApiError.conflict(
        `Roll number ${rollNo} belongs to a deleted student. Restore the student from the Recycle Bin, or permanently delete them there first, then add this student again.`,
      );
    }
  }
  if (admissionNo && admissionNo.trim()) {
    const deleted = await db.student.findFirst({ where: { schoolId: schoolId, admissionNo: admissionNo.trim(), deletedAt: { not: null } } });
    if (deleted) {
      throw ApiError.conflict(
        `Admission number ${admissionNo.trim()} belongs to a deleted student. Restore the student from the Recycle Bin, or permanently delete them there first, then add this student again.`,
      );
    }
  }
  throw ApiError.conflict('A student with these values already exists');
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
  const inClass = await db.student.findMany({ where: { schoolId: schoolId, classId: classId, deletedAt: null } });
  for (const s of inClass) {
    if (excludeId && s.id === excludeId) continue;
    if (normalizeName(s.name) === norm) return `A student named "${s.name}" already exists in this class`;
    if (phoneHash && s.parentPhoneHash === phoneHash && normalizeName(s.name) === norm) {
      return `A student named "${s.name}" with the same parent number already exists`;
    }
  }
  if (phoneHash) {
    const samePhone = await db.student.findMany({ where: { schoolId: schoolId, parentPhoneHash: phoneHash, deletedAt: null } });
    for (const s of samePhone) {
      if (excludeId && s.id === excludeId) continue;
      if (normalizeName(s.name) === norm) return `A student named "${s.name}" with the same parent number already exists in this school`;
    }
  }
  return null;
}

async function assertRollUnique(db: Db, schoolId: string, classId: string, rollNo: number | null | undefined, excludeId?: string): Promise<void> {
  if (rollNo === null || rollNo === undefined) return;
  const existing = await db.student.findFirst({ where: { schoolId: schoolId, classId: classId, rollNo: rollNo, deletedAt: null } });
  if (existing && existing.id !== excludeId) {
    throw ApiError.conflict(`Roll number ${rollNo} is already used in this class`);
  }
}

/**
 * 6B: admission_no is unique per school (SCHEMA.md §1; DB unique
 * (schoolId, admissionNo), NULLs never collide). Checked in the app layer
 * so the error is a clean 409 instead of a Prisma P2002.
 */
async function assertAdmissionNoUnique(db: Db, schoolId: string, admissionNo: string | null | undefined, excludeId?: string): Promise<void> {
  if (!admissionNo || !admissionNo.trim()) return;
  const existing = await db.student.findFirst({ where: { schoolId: schoolId, admissionNo: admissionNo.trim(), deletedAt: null } });
  if (existing && existing.id !== excludeId) {
    throw ApiError.conflict(`Admission number ${admissionNo.trim()} is already used in this school`);
  }
}

export async function createStudent(db: Db, schoolId: string, classId: string, input: StudentInput, actorId?: string): Promise<any> {
  await assertClassInSchool(db, schoolId, classId);
  const phone = parentPhoneFields(input.parent_phone);
  const phone2 = parentPhoneFields(input.parent2_phone);
  const dup = await findDuplicate(db, schoolId, classId, input.name.trim(), phone.hash);
  if (dup) throw ApiError.conflict(dup);
  await assertRollUnique(db, schoolId, classId, input.roll_no);
  await assertAdmissionNoUnique(db, schoolId, input.admission_no);
  if (input.gender !== undefined && input.gender !== null && !['male', 'female', 'other'].includes(input.gender)) {
    throw ApiError.validation("gender must be 'male', 'female' or 'other'");
  }
  let created: any;
  try {
    created = await db.student.create({
      data: {
        schoolId: schoolId,
        classId: classId,
        name: input.name.trim(),
        nameUr: input.name_ur?.trim() || null,
        rollNo: input.roll_no ?? null,
        parentName: input.parent_name?.trim() || null,
        parentNameUr: input.parent_name_ur?.trim() || null,
        parentPhoneEnc: phone.enc,
        parentPhoneHash: phone.hash,
        parentOptOut: input.parent_opt_out ?? false,
        status: 'active',
        fatherName: input.father_name?.trim() || null,
        admissionNo: input.admission_no?.trim() || null,
        dateOfBirth: input.date_of_birth ? new Date(input.date_of_birth) : null,
        gender: input.gender ?? null,
        address: input.address?.trim() || null,
        admissionDate: input.admission_date ? new Date(input.admission_date) : null,
        parent2Name: input.parent2_name?.trim() || null,
        parent2PhoneEnc: phone2.enc,
        parent2PhoneHash: phone2.hash,
        parent2OptOut: input.parent2_opt_out ?? false,
      },
    });
  } catch (err) {
    // D1: P2002 here means a soft-deleted student still holds the
    // (classId, rollNo) or (schoolId, admissionNo) key.
    if (isUniqueViolation(err)) await throwStudentUniqueConflict(db, schoolId, classId, input.roll_no, input.admission_no);
    throw err;
  }
  await logCreate(db, { schoolId, actorId: actorId ?? null, entity: 'student', entityId: created.id, after: changeView(created) });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'student.create', entity: 'student', entityId: created.id, details: { class_id: classId, name: created.name } });
  return created;
}

/**
 * Round 5 (F1): duplicate phone flags must be computed over the WHOLE
 * class/school, not just the loaded page. With server-side pagination the
 * old withDuplicateFlags only saw the current page, so a duplicate pair
 * split across pages was invisible on both pages. This fetches only the
 * three columns the check needs (no phone decryption).
 */
async function duplicateFlagIds(db: Db, schoolId: string, classId?: string): Promise<Set<string>> {
  const where: Record<string, unknown> = { schoolId: schoolId, deletedAt: null };
  if (classId) where.classId = classId;
  const all: any[] = await db.student.findMany({ where, select: { id: true, parentPhoneHash: true, name: true } });
  const counts = new Map<string, number>();
  for (const s of all) {
    if (!s.parentPhoneHash) continue;
    const key = `${s.parentPhoneHash}|${normalizeName(s.name)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ids = new Set<string>();
  for (const s of all) {
    if (!s.parentPhoneHash) continue;
    if ((counts.get(`${s.parentPhoneHash}|${normalizeName(s.name)}`) ?? 0) > 1) ids.add(s.id);
  }
  return ids;
}

/** Upgrade phone_flag to 'duplicate' from a precomputed whole-scope id set. */
function applyDuplicateFlags(publics: Record<string, unknown>[], dupIds: Set<string>): Record<string, unknown>[] {
  return publics.map((p) => (!p.phone_flag && dupIds.has(p.id as string) ? { ...p, phone_flag: 'duplicate' } : p));
}

/** Round 5 (F1): server-side phone-flag filter for listStudents. Missing /
 * invalid filter in the database; 'duplicate' needs the whole-class id set
 * (same (phone, name) pair, computed above) because no single row carries it.
 */
async function flagWhere(db: Db, schoolId: string, classId: string, flag: string): Promise<Record<string, unknown>> {
  if (flag === 'missing') return { parentPhoneEnc: null };
  if (flag === 'invalid') return { parentPhoneEnc: { not: null }, parentPhoneHash: null };
  if (flag === 'duplicate') {
    const ids = await duplicateFlagIds(db, schoolId, classId);
    return { id: { in: [...ids] } };
  }
  return {};
}

export async function listStudents(
  db: Db,
  schoolId: string,
  classId: string,
  query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  await assertClassInSchool(db, schoolId, classId);
  const { page, limit, skip } = parsePagination(query);
  // FINAL REBUILD Point 3: live search. `q` is the new param; `search`
  // is kept as an alias (existing pages + older clients already send it).
  // Empty q = plain list (all students); a non-empty q matches nothing
  // → total 0 ("No student found" in the UI). Server-side only — the
  // client never fetches all students, so 1000+ rows stay fast.
  const search = String(query.q ?? query.search ?? '').trim();
  const status = String(query.status ?? '').trim();
  const flag = String(query.flag ?? '').trim();
  const where: Record<string, unknown> = { schoolId: schoolId, classId: classId, deletedAt: null };
  if (status) where.status = status;
  if (flag) Object.assign(where, await flagWhere(db, schoolId, classId, flag));
  const or: Record<string, unknown>[] = [];
  if (search) {
    // Partial match anywhere, case-insensitive, Urdu + English. Prisma
    // `contains` + `insensitive` is a substring match, so "ahm" finds
    // "Ahmed" and "احم" finds "احمد". Fields: student name (EN + Urdu),
    // father's name, parent/guardian name, admission number. Roll number
    // is an Int, so it matches exactly when the query parses as a number.
    or.push({ name: { contains: search, mode: 'insensitive' } });
    or.push({ nameUr: { contains: search, mode: 'insensitive' } });
    or.push({ fatherName: { contains: search, mode: 'insensitive' } });
    or.push({ parentName: { contains: search, mode: 'insensitive' } });
    or.push({ admissionNo: { contains: search, mode: 'insensitive' } });
    const asNum = Number.parseInt(search, 10);
    if (!Number.isNaN(asNum)) or.push({ rollNo: asNum });
  }
  const whereWithSearch = or.length > 0 ? { ...where, OR: or } : where;
  const [items, total, dupIds] = await Promise.all([
    db.student.findMany({ where: whereWithSearch, orderBy: [{ rollNo: 'asc' }, { name: 'asc' }], skip, take: limit }),
    db.student.count({ where: whereWithSearch }),
    duplicateFlagIds(db, schoolId, classId),
  ]);
  const pageOut = paginatedResponse(applyDuplicateFlags(items.map(toPublicStudent), dupIds), total, { page, limit, skip });
  return pageOut;
}

export async function getStudent(db: Db, schoolId: string, id: string): Promise<any> {
  const s = await db.student.findFirst({ where: { id, schoolId: schoolId, deletedAt: null } });
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
  let phone2Hash = existing.parent2PhoneHash as string | null;
  let phone2Enc = existing.parent2PhoneEnc as string | null;
  if (patch.parent2_phone !== undefined) {
    const phone2 = parentPhoneFields(patch.parent2_phone);
    phone2Enc = phone2.enc;
    phone2Hash = phone2.hash;
  }
  const dup = await findDuplicate(db, schoolId, targetClassId, name, phoneHash, id);
  if (dup) throw ApiError.conflict(dup);
  await assertRollUnique(db, schoolId, targetClassId, patch.roll_no !== undefined ? patch.roll_no : existing.rollNo, id);
  if (patch.admission_no !== undefined) await assertAdmissionNoUnique(db, schoolId, patch.admission_no, id);
  const data: Record<string, unknown> = {
    name,
    classId: targetClassId,
    parentPhoneEnc: phoneEnc,
    parentPhoneHash: phoneHash,
    parent2PhoneEnc: phone2Enc,
    parent2PhoneHash: phone2Hash,
  };
  if (patch.name_ur !== undefined) data.nameUr = patch.name_ur?.trim() || null;
  if (patch.roll_no !== undefined) data.rollNo = patch.roll_no ?? null;
  if (patch.parent_name !== undefined) data.parentName = patch.parent_name?.trim() || null;
  if (patch.parent_name_ur !== undefined) data.parentNameUr = patch.parent_name_ur?.trim() || null;
  if (patch.parent_opt_out !== undefined) data.parentOptOut = patch.parent_opt_out;
  if (patch.status !== undefined) {
    if (!['active', 'left', 'struck_off', 'graduated'].includes(patch.status)) throw ApiError.validation('Invalid status');
    data.status = patch.status;
  }
  if (patch.father_name !== undefined) data.fatherName = patch.father_name?.trim() || null;
  if (patch.admission_no !== undefined) data.admissionNo = patch.admission_no?.trim() || null;
  if (patch.date_of_birth !== undefined) data.dateOfBirth = patch.date_of_birth ? new Date(patch.date_of_birth) : null;
  if (patch.gender !== undefined) {
    if (patch.gender !== null && !['male', 'female', 'other'].includes(patch.gender)) {
      throw ApiError.validation("gender must be 'male', 'female' or 'other'");
    }
    data.gender = patch.gender;
  }
  if (patch.address !== undefined) data.address = patch.address?.trim() || null;
  if (patch.admission_date !== undefined) data.admissionDate = patch.admission_date ? new Date(patch.admission_date) : null;
  if (patch.parent2_name !== undefined) data.parent2Name = patch.parent2_name?.trim() || null;
  if (patch.parent2_opt_out !== undefined) data.parent2OptOut = patch.parent2_opt_out;
  // Snapshot the before-view BEFORE the update: some DB layers mutate the
  // fetched row object in place, which would erase the old values.
  const beforeView = changeView(existing);
  let updated: any;
  try {
    updated = await db.student.update({ where: { id }, data });
  } catch (err) {
    // D1: P2002 here means a soft-deleted student still holds the target
    // roll number / admission number (e.g. moving a student onto a
    // deleted student's roll number).
    if (isUniqueViolation(err)) {
      await throwStudentUniqueConflict(
        db,
        schoolId,
        targetClassId,
        patch.roll_no !== undefined ? patch.roll_no : existing.rollNo,
        patch.admission_no !== undefined ? patch.admission_no : existing.admissionNo,
      );
    }
    throw err;
  }
  await writeChangeLogs(db, {
    schoolId,
    actorId: actorId ?? null,
    entity: 'student',
    entityId: id,
    before: beforeView,
    after: changeView(updated),
  });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'student.update', entity: 'student', entityId: id, details: { name } });
  return updated;
}

/**
 * 6B: move a student between sections/classes (e.g. 5-A -> 5-B, or 5-A ->
 * 6-A). The target class must belong to the same school; roll number and
 * name must be free in the target class. Writes change_logs (class_id) +
 * audit `student.move`. The caller (route) wraps this in a ConfirmDialog.
 */
export async function moveStudent(db: Db, schoolId: string, id: string, toClassId: string, actorId?: string): Promise<any> {
  const existing = await getStudent(db, schoolId, id);
  if (existing.classId === toClassId) throw ApiError.validation('Student is already in that class');
  await assertClassInSchool(db, schoolId, toClassId);
  await assertRollUnique(db, schoolId, toClassId, existing.rollNo, id);
  const dup = await findDuplicate(db, schoolId, toClassId, existing.name, existing.parentPhoneHash as string | null, id);
  if (dup) throw ApiError.conflict(dup);
  const beforeView = changeView(existing);
  const updated = await db.student.update({ where: { id }, data: { classId: toClassId } });
  await writeChangeLogs(db, {
    schoolId,
    actorId: actorId ?? null,
    entity: 'student',
    entityId: id,
    before: beforeView,
    after: changeView(updated),
  });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'student.move', entity: 'student', entityId: id, details: { name: existing.name, from_class_id: existing.classId, to_class_id: toClassId } });
  return updated;
}

/** 6B: stamp the ID-card-issued flag (contracts/API.md).
 * NOTE: the live route for this is POST /students/:id/issue-id-card in
 * the 6C-2 certificates router; this helper is kept for the approval
 * applier / service-level callers. */
export async function issueIdCard(db: Db, schoolId: string, id: string, actorId?: string): Promise<any> {
  const existing = await getStudent(db, schoolId, id);
  const beforeView = changeView(existing);
  const updated = await db.student.update({ where: { id }, data: { idCardIssuedAt: new Date() } });
  await writeChangeLogs(db, {
    schoolId,
    actorId: actorId ?? null,
    entity: 'student',
    entityId: id,
    before: { ...beforeView, id_card_issued_at: existing.idCardIssuedAt ? new Date(existing.idCardIssuedAt).toISOString() : null },
    after: { ...changeView(updated), id_card_issued_at: (updated.idCardIssuedAt as Date).toISOString() },
  });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'student.issue_id_card', entity: 'student', entityId: id, details: { name: existing.name } });
  return updated;
}

/**
 * 6B: school-wide student search (contracts/API.md `GET /students`):
 * filter by admission_no, status (incl. struck_off/graduated), class_id,
 * free-text search over name / admission_no. Soft-deleted rows excluded.
 */
export async function listStudentsSchoolWide(
  db: Db,
  schoolId: string,
  query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  // Point 3: same `q` (alias `search`) live search as listStudents.
  const search = String(query.q ?? query.search ?? '').trim();
  const status = String(query.status ?? '').trim();
  const admissionNo = String(query.admission_no ?? '').trim();
  const classId = String(query.class_id ?? '').trim();
  const where: Record<string, unknown> = { schoolId: schoolId, deletedAt: null };
  if (status) where.status = status;
  if (admissionNo) where.admissionNo = admissionNo;
  if (classId) where.classId = classId;
  const or: Record<string, unknown>[] = [];
  if (search) {
    or.push({ name: { contains: search, mode: 'insensitive' } });
    or.push({ nameUr: { contains: search, mode: 'insensitive' } });
    or.push({ fatherName: { contains: search, mode: 'insensitive' } });
    or.push({ parentName: { contains: search, mode: 'insensitive' } });
    or.push({ admissionNo: { contains: search, mode: 'insensitive' } });
    const asNum = Number.parseInt(search, 10);
    if (!Number.isNaN(asNum)) or.push({ rollNo: asNum });
  }
  const whereWithSearch = or.length > 0 ? { ...where, OR: or } : where;
  const [items, total, dupIds] = await Promise.all([
    db.student.findMany({ where: whereWithSearch, orderBy: [{ name: 'asc' }], skip, take: limit }),
    db.student.count({ where: whereWithSearch }),
    duplicateFlagIds(db, schoolId),
  ]);
  return paginatedResponse(applyDuplicateFlags(items.map(toPublicStudent), dupIds), total, { page, limit, skip });
}

/**
 * Soft delete (6A): sets deleted_at + writes a deleted_records snapshot
 * instead of hard-deleting. The old "cannot delete with history" block is
 * gone on purpose — soft delete PRESERVES the attendance/fee history, so
 * the row stays restorable from the recycle bin for 30 days.
 */
export async function deleteStudent(db: Db, schoolId: string, id: string, actorId?: string): Promise<void> {
  const existing = await getStudent(db, schoolId, id);
  await softDeleteEntity(db, { schoolId, entity: 'student', entityId: id, deletedBy: actorId ?? null });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'student.delete', entity: 'student', entityId: id, details: { name: existing.name, soft_deleted: true } });
}

export async function updateParent(
  db: Db,
  schoolId: string,
  id: string,
  input: { parent_name?: string | null; parent_name_ur?: string | null; parent_phone?: string | null; opt_out?: boolean },
  actorId?: string,
): Promise<any> {
  const existing = await getStudent(db, schoolId, id);
  const data: Record<string, unknown> = {};
  if (input.parent_name !== undefined) data.parentName = input.parent_name?.trim() || null;
  if (input.parent_name_ur !== undefined) data.parentNameUr = input.parent_name_ur?.trim() || null;
  if (input.opt_out !== undefined) data.parentOptOut = input.opt_out;
  if (input.parent_phone !== undefined) {
    const phone = parentPhoneFields(input.parent_phone);
    data.parentPhoneEnc = phone.enc;
    data.parentPhoneHash = phone.hash;
  }
  const beforeView = changeView(existing);
  const updated = await db.student.update({ where: { id }, data });
  await writeChangeLogs(db, {
    schoolId,
    actorId: actorId ?? null,
    entity: 'student',
    entityId: id,
    before: beforeView,
    after: changeView(updated),
  });
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
  const all = await db.student.findMany({ where: { schoolId: schoolId, status: 'active', deletedAt: null }, orderBy: [{ name: 'asc' }] });
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
  const pageRows = filtered.slice(skip, skip + limit);
  // Round 5 (F1): duplicate flags from the whole school, not just the page.
  const dupIds = await duplicateFlagIds(db, schoolId);
  const items = applyDuplicateFlags(pageRows.map(toPublicStudent), dupIds);
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
  // 6B: extended profile columns accepted in the import file.
  father_name?: string | null;
  admission_no?: string | null;
  date_of_birth?: string | null;
  gender?: string | null;
  address?: string | null;
  admission_date?: string | null;
  parent2_name?: string | null;
  parent2_phone?: string | null;
}

export interface ImportPreviewRow {
  row: number;
  status: 'ok' | 'duplicate' | 'invalid';
  reason: string | null;
  data: ImportRow;
}

export interface ImportPreview {
  total: number;
  valid: number;
  duplicates_flagged: number;
  invalid_rows: Array<{ row: number; reason: string }>;
  preview: ImportPreviewRow[];
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
    // Round 5 (F10): a row with an empty name used to be skipped silently
    // here (`if (!name) continue`) before validation ever saw it — the
    // preview total did not even count it. Keep skipping genuinely blank
    // lines (no cell has content), but carry any other empty-name row
    // through so previewImport reports it as invalid ("Missing student
    // name") instead of dropping it without a trace.
    const hasContent = r.some((c) => (c ?? '').trim() !== '');
    if (!hasContent) continue;
    const name = (r[idx('name')] ?? '').trim();
    const rollRaw = (r[idx('roll_no')] ?? '').trim();
    const rollNo = rollRaw === '' ? null : Number.parseInt(rollRaw, 10);
    const cell = (h: string): string | null => {
      const v = (r[idx(h)] ?? '').trim();
      return v || null;
    };
    out.push({
      name,
      name_ur: cell('name_ur'),
      roll_no: rollNo !== null && !Number.isNaN(rollNo) ? rollNo : null,
      parent_name: cell('parent_name'),
      parent_phone: cell('parent_phone'),
      father_name: cell('father_name'),
      admission_no: cell('admission_no'),
      date_of_birth: cell('date_of_birth'),
      gender: cell('gender'),
      address: cell('address'),
      admission_date: cell('admission_date'),
      parent2_name: cell('parent2_name'),
      parent2_phone: cell('parent2_phone'),
    });
  }
  return out;
}

export async function parseXlsxBuffer(buf: Buffer): Promise<ImportRow[]> {
  return rowsToImportRows(await parseXlsxGrid(buf));
}

/** Raw string grid of the first worksheet — shared by the student and
 * parent imports (each maps the grid to its own row shape). */
export async function parseXlsxGrid(buf: Buffer): Promise<string[][]> {
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
  return grid;
}

/**
 * 6B: per-row validation for CSV/Excel import WITHOUT writing anything.
 * The preview screen shows this first; only rows with status 'ok' are
 * imported when the admin confirms. Checks, in order: missing name,
 * invalid parent/parent2 phone, invalid gender/date, duplicate name in
 * the class, duplicate roll in the class, duplicate admission_no in the
 * school — each against existing rows AND against earlier rows in the file.
 */
export async function previewImport(
  db: Db,
  schoolId: string,
  classId: string,
  rows: ImportRow[],
): Promise<ImportPreview> {
  await assertClassInSchool(db, schoolId, classId);
  const existing = await db.student.findMany({ where: { schoolId: schoolId, deletedAt: null } });
  const inClass = existing.filter((s: any) => s.classId === classId);
  const existingNames = new Set(inClass.map((s: any) => normalizeName(s.name)));
  const existingRolls = new Set(inClass.map((s: any) => s.rollNo).filter((r: any) => r !== null && r !== undefined));
  const existingPhones = new Set(existing.map((s: any) => (s.parentPhoneHash ? `${s.parentPhoneHash}|${normalizeName(s.name)}` : '')).filter((h: string) => !!h));
  const existingAdmissions = new Set(existing.map((s: any) => (s.admissionNo ?? '').trim()).filter((a: string) => !!a));
  const seenNames = new Set<string>();
  const seenRolls = new Set<number>();
  const seenAdmissions = new Set<string>();
  const preview: ImportPreviewRow[] = [];
  const invalid_rows: Array<{ row: number; reason: string }> = [];
  let duplicates = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNo = i + 2; // 1-based incl. header
    const fail = (reason: string): ImportPreviewRow => {
      invalid_rows.push({ row: rowNo, reason });
      return { row: rowNo, status: 'invalid', reason, data: row };
    };
    const dupe = (reason: string): ImportPreviewRow => {
      duplicates += 1;
      return { row: rowNo, status: 'duplicate', reason, data: row };
    };
    if (!row.name || !row.name.trim()) { preview.push(fail('Missing student name')); continue; }
    const norm = normalizeName(row.name);
    if (row.parent_phone) {
      if (!normalizePhone(row.parent_phone)) { preview.push(fail(`Invalid parent phone: ${row.parent_phone}`)); continue; }
    }
    if (row.parent2_phone) {
      if (!normalizePhone(row.parent2_phone)) { preview.push(fail(`Invalid second-parent phone: ${row.parent2_phone}`)); continue; }
    }
    if (row.gender && !['male', 'female', 'other'].includes(row.gender.trim().toLowerCase())) {
      preview.push(fail(`Invalid gender: ${row.gender} (male/female/other)`)); continue;
    }
    let badDate: string | null = null;
    for (const d of [row.date_of_birth, row.admission_date]) {
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d.trim())) { badDate = d; break; }
    }
    if (badDate) { preview.push(fail(`Invalid date (use YYYY-MM-DD): ${badDate}`)); continue; }
    if (existingNames.has(norm) || seenNames.has(norm)) { preview.push(dupe(`A student named "${row.name.trim()}" already exists in this class`)); continue; }
    seenNames.add(norm);
    if (row.roll_no !== null && row.roll_no !== undefined) {
      if (existingRolls.has(row.roll_no) || seenRolls.has(row.roll_no)) {
        preview.push(fail(`Roll number ${row.roll_no} already exists in this class`)); continue;
      }
      seenRolls.add(row.roll_no);
    }
    const adm = (row.admission_no ?? '').trim();
    if (adm) {
      if (existingAdmissions.has(adm) || seenAdmissions.has(adm)) {
        preview.push(fail(`Admission number ${adm} is already used in this school`)); continue;
      }
      seenAdmissions.add(adm);
    }
    if (row.parent_phone) {
      // Duplicate rule (SCHEMA.md): same phone + same normalized name.
      // Siblings legitimately share a parent number — phone alone is NOT a duplicate.
      const hash = sha256Hex(normalizePhone(row.parent_phone)!);
      if (existingPhones.has(`${hash}|${norm}`)) { preview.push(dupe(`A student named "${row.name.trim()}" with the same parent number already exists`)); continue; }
    }
    preview.push({ row: rowNo, status: 'ok', reason: null, data: row });
  }
  const valid = preview.filter((p) => p.status === 'ok').length;
  return { total: rows.length, valid, duplicates_flagged: duplicates, invalid_rows, preview };
}

export async function importStudents(
  db: Db,
  schoolId: string,
  classId: string,
  rows: ImportRow[],
  actorId?: string,
): Promise<ImportResult> {
  // Single validation path: preview first, then create only 'ok' rows.
  // All imports are DRAFT until this confirmed import runs.
  const preview = await previewImport(db, schoolId, classId, rows);
  const result: ImportResult = { imported: 0, duplicates_flagged: preview.duplicates_flagged, invalid_rows: preview.invalid_rows, saved_ids: [] };
  for (const item of preview.preview) {
    if (item.status !== 'ok') continue;
    const row = item.data;
    let phoneEnc: string | null = null;
    let phoneHash: string | null = null;
    if (row.parent_phone) {
      const normalized = normalizePhone(row.parent_phone)!;
      phoneEnc = encryptPhone(normalized);
      phoneHash = sha256Hex(normalized);
    }
    let phone2Enc: string | null = null;
    let phone2Hash: string | null = null;
    if (row.parent2_phone) {
      const normalized2 = normalizePhone(row.parent2_phone)!;
      phone2Enc = encryptPhone(normalized2);
      phone2Hash = sha256Hex(normalized2);
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
        fatherName: row.father_name?.trim() || null,
        admissionNo: row.admission_no?.trim() || null,
        dateOfBirth: row.date_of_birth ? new Date(row.date_of_birth) : null,
        gender: row.gender?.trim().toLowerCase() || null,
        address: row.address?.trim() || null,
        admissionDate: row.admission_date ? new Date(row.admission_date) : null,
        parent2Name: row.parent2_name?.trim() || null,
        parent2PhoneEnc: phone2Enc,
        parent2PhoneHash: phone2Hash,
        parent2OptOut: false,
      },
    });
    result.imported += 1;
    result.saved_ids.push(created.id);
    await logCreate(db, { schoolId, actorId: actorId ?? null, entity: 'student', entityId: created.id, after: changeView(created) });
  }
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'student.import', entity: 'class', entityId: classId, details: { imported: result.imported, duplicates: result.duplicates_flagged, invalid: result.invalid_rows.length } });
  return result;
}

// ---------------------------------------------------------------------------
// Parents bulk import (CSV / Excel) — Phase 9 fix: the Parents page had no
// bulk-import control at all. Same preview-first pattern as importStudents:
// validate every row, show the preview, import only 'ok' rows.
// Columns: admission_no (preferred — unique per school), student (name,
// used only when admission_no is blank), parent_name, parent_phone.
// Matching: admission_no wins; otherwise the student name must match
// exactly one student in the school. The number is validated with
// normalizePhone (Pakistani mobile) and stored encrypted, like the
// single-student parent update. A row is a duplicate when the student
// already has that exact number on file, or appears twice in the file.
// ---------------------------------------------------------------------------

export interface ParentImportRow {
  admission_no?: string | null;
  student_name: string;
  parent_name?: string | null;
  parent_phone?: string | null;
}

export interface ParentImportPreviewRow {
  row: number;
  status: 'ok' | 'duplicate' | 'invalid';
  reason: string | null;
  data: ParentImportRow;
  student_id: string | null;
  student_name: string | null;
}

export interface ParentImportPreview {
  total: number;
  valid: number;
  duplicates_flagged: number;
  invalid_rows: Array<{ row: number; reason: string }>;
  preview: ParentImportPreviewRow[];
}

export interface ParentImportResult {
  imported: number;
  duplicates_flagged: number;
  invalid_rows: Array<{ row: number; reason: string }>;
  saved_ids: string[];
}

/** Map a parsed CSV/Excel grid to parent-import rows (header row first). */
export function parentRowsFromGrid(grid: string[][]): ParentImportRow[] {
  if (grid.length === 0) return [];
  const headers = grid[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const idx = (name: string): number => headers.indexOf(name);
  const nameIdx = idx('student') >= 0 ? idx('student') : idx('student_name');
  const out: ParentImportRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    const cell = (h: string): string | null => {
      const v = (r[idx(h)] ?? '').trim();
      return v || null;
    };
    const studentName = nameIdx >= 0 ? (r[nameIdx] ?? '').trim() : '';
    const admissionNo = cell('admission_no');
    if (!studentName && !admissionNo) continue;
    out.push({
      admission_no: admissionNo,
      student_name: studentName,
      parent_name: cell('parent_name'),
      parent_phone: cell('parent_phone'),
    });
  }
  return out;
}

export async function previewParentsImport(
  db: Db,
  schoolId: string,
  rows: ParentImportRow[],
): Promise<ParentImportPreview> {
  const all: any[] = await db.student.findMany({ where: { schoolId: schoolId, deletedAt: null } });
  const byAdmission = new Map<string, any>();
  const byName = new Map<string, any[]>();
  for (const s of all) {
    if ((s.admissionNo ?? '').trim()) byAdmission.set((s.admissionNo as string).trim(), s);
    const key = normalizeName(s.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(s);
  }
  const preview: ParentImportPreviewRow[] = [];
  const invalid_rows: Array<{ row: number; reason: string }> = [];
  const seenStudents = new Set<string>();
  let duplicates = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNo = i + 2; // 1-based incl. header
    const fail = (reason: string): ParentImportPreviewRow => {
      invalid_rows.push({ row: rowNo, reason });
      return { row: rowNo, status: 'invalid', reason, data: row, student_id: null, student_name: null };
    };
    const dupe = (reason: string, student: any): ParentImportPreviewRow => {
      duplicates += 1;
      return { row: rowNo, status: 'duplicate', reason, data: row, student_id: student.id, student_name: student.name };
    };
    let student: any = null;
    const adm = (row.admission_no ?? '').trim();
    if (adm) {
      student = byAdmission.get(adm) ?? null;
      if (!student) { preview.push(fail(`No student with admission number ${adm}`)); continue; }
    } else {
      const name = (row.student_name ?? '').trim();
      if (!name) { preview.push(fail('Give an admission number or a student name')); continue; }
      const matches = byName.get(normalizeName(name)) ?? [];
      if (matches.length === 0) { preview.push(fail(`No student named "${name}"`)); continue; }
      if (matches.length > 1) { preview.push(fail(`"${name}" matches ${matches.length} students — use the admission number instead`)); continue; }
      student = matches[0];
    }
    if (!row.parent_phone || !row.parent_phone.trim()) {
      preview.push(fail(`Missing parent phone for ${student.name}`));
      continue;
    }
    const normalized = normalizePhone(row.parent_phone);
    if (!normalized) {
      preview.push(fail(`Invalid parent phone: ${row.parent_phone}`));
      continue;
    }
    if (student.parentPhoneHash && student.parentPhoneHash === sha256Hex(normalized)) {
      preview.push(dupe(`${student.name} already has this number on file`, student));
      continue;
    }
    if (seenStudents.has(student.id)) {
      preview.push(dupe(`${student.name} appears twice in this file`, student));
      continue;
    }
    seenStudents.add(student.id);
    preview.push({ row: rowNo, status: 'ok', reason: null, data: row, student_id: student.id, student_name: student.name });
  }
  const valid = preview.filter((p) => p.status === 'ok').length;
  return { total: rows.length, valid, duplicates_flagged: duplicates, invalid_rows, preview };
}

export async function importParents(
  db: Db,
  schoolId: string,
  rows: ParentImportRow[],
  actorId?: string,
): Promise<ParentImportResult> {
  const preview = await previewParentsImport(db, schoolId, rows);
  const result: ParentImportResult = { imported: 0, duplicates_flagged: preview.duplicates_flagged, invalid_rows: preview.invalid_rows, saved_ids: [] };
  for (const item of preview.preview) {
    if (item.status !== 'ok' || !item.student_id) continue;
    const normalized = normalizePhone(item.data.parent_phone!)!;
    const data: Record<string, unknown> = {
      parentPhoneEnc: encryptPhone(normalized),
      parentPhoneHash: sha256Hex(normalized),
    };
    if (item.data.parent_name?.trim()) data.parentName = item.data.parent_name.trim();
    const beforeStudent = await db.student.findFirst({ where: { id: item.student_id, schoolId } });
    // Snapshot the scalar before-values BEFORE the update: some stores
    // mutate the fetched row in place, which would erase the old values.
    const beforeParent = beforeStudent
      ? {
          parent_name: beforeStudent.parentName ?? null,
          parent_phone: beforeStudent.parentPhoneEnc ? maskPhone(decryptPhone(beforeStudent.parentPhoneEnc)) : null,
        }
      : null;
    await db.student.update({ where: { id: item.student_id }, data });
    if (beforeParent) {
      await writeChangeLogs(db, {
        schoolId,
        actorId: actorId ?? null,
        entity: 'student',
        entityId: item.student_id,
        before: beforeParent,
        after: { parent_name: data.parentName ?? beforeParent.parent_name, parent_phone: maskPhone(normalized) },
      });
    }
    result.imported += 1;
    result.saved_ids.push(item.student_id);
  }
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'parent.import', entity: 'school', entityId: schoolId, details: { imported: result.imported, duplicates: result.duplicates_flagged, invalid: result.invalid_rows.length } });
  return result;
}
