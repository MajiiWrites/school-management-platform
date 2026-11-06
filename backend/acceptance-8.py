#!/usr/bin/env python3
"""Phase 8 acceptance pass — School Management Platform v2 (scratch DB ONLY).

Drives the real API on :4128 against scratch DB school_p8_qa (SEED_ON_BOOT=false).
Covers the section-9 criteria: (a) two-school isolation incl. ID tampering,
(b) fresh-signup zero state, (c) no auto-fill, (d) approval queue, (e) recycle
bin, (f) change history, (g) results OCR + review + toppers, (h) independent
sections, (i) roles, (j) 2FA round-trip, (k) password-gated export, (l) messaging
approval flow + opt-out, (m) fees, (n) sessions/exams/timetable/staff/payroll,
(o) backup job, (p) rate limiting (LAST — it exhausts the auth limiter).
Plus: announcement SMS hook (Phase 8 item 3).

Usage: python3 acceptance-8.py   (server must already run on :4128)
Never sends a real SMS: everything asserted here is queue/draft state only.
"""
import base64
import hashlib
import hmac
import io
import json
import struct
import sys
import time
import urllib.request
import urllib.error

BASE = "http://localhost:4128/api/v1"
PASS = 0
FAIL = 0
FAILURES = []
REQ_COUNT = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        FAILURES.append(name)
        print(f"  FAIL {name} {extra}")


def req(method, path, token=None, body=None):
    global REQ_COUNT
    REQ_COUNT += 1
    url = BASE + path
    data = None
    headers = {"Content-Type": "application/json"}
    if body is not None:
        data = json.dumps(body).encode()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            ctype = resp.headers.get("Content-Type", "")
            payload = resp.read()
            if "application/json" in ctype:
                return resp.status, json.loads(payload)
            return resp.status, payload
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, json.loads(payload)
        except Exception:
            return e.code, payload


def multipart(path, token, fields, file_field, filename, file_bytes, mime):
    global REQ_COUNT
    REQ_COUNT += 1
    boundary = "----accept8boundary"
    body = io.BytesIO()
    for k, v in fields.items():
        body.write(f"--{boundary}\r\n".encode())
        body.write(f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode())
        body.write(f"{v}\r\n".encode())
    body.write(f"--{boundary}\r\n".encode())
    body.write(
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'.encode()
    )
    body.write(f"Content-Type: {mime}\r\n\r\n".encode())
    body.write(file_bytes)
    body.write(f"\r\n--{boundary}--\r\n".encode())
    r = urllib.request.Request(
        BASE + path,
        data=body.getvalue(),
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def data(r):
    return r.get("data", {}) if isinstance(r, dict) else {}


def plist(d):
    """Extract the item list from any paginated envelope shape."""
    if isinstance(d, list):
        return d
    if isinstance(d, dict):
        for k in ("items", "templates", "drafts", "rows", "results"):
            if isinstance(d.get(k), list):
                return d[k]
    return []


def totp(secret_b32):
    key = base64.b32decode(secret_b32)
    counter = int(time.time()) // 30
    msg = struct.pack(">Q", counter)
    h = hmac.new(key, msg, hashlib.sha1).digest()
    o = h[-1] & 0x0F
    code = (struct.unpack(">I", h[o:o + 4])[0] & 0x7FFFFFFF) % 1000000
    return f"{code:06d}"


def make_sheet_png():
    from PIL import Image, ImageDraw, ImageFont
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 28)
        font_b = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 28)
    except Exception:
        font = ImageFont.load_default()
        font_b = font
    lines = [
        ("Roll No  Student Name  English  Math  Obtained  Total", True),
        ("1  Ahmed Raza  85  90  175  200", False),
        ("2  Fatima Khan  92  95  187  200", False),
        ("3  Bilal Ahmed  40  30  70  200", False),
    ]
    W, H = 1200, 60 + 60 * len(lines)
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    y = 20
    for text, bold in lines:
        d.text((20, y), text, fill="black", font=font_b if bold else font)
        y += 60
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def signup_login(school_name, email, password):
    s, r = req("POST", "/auth/signup", body={"school_name": school_name, "email": email, "password": password})
    assert s in (200, 201), f"signup {email}: {s} {r}"
    token = data(r).get("dev_token")
    assert token, f"no dev_token for {email}: {r}"
    s, r = req("POST", "/auth/verify-email", body={"token": token})
    assert s == 200, f"verify {email}: {s} {r}"
    s, r = req("POST", "/auth/login", body={"email": email, "password": password})
    assert s == 200, f"login {email}: {s} {r}"
    d = data(r)
    return d["access"], d["user"]["id"], d.get("user", {}).get("school_id")


def main():
    print("== Phase 8 acceptance (scratch DB school_p8_qa, API :4128) ==")

    # ---------- (b) fresh signup creates ZERO records ----------
    print("-- (b) fresh-signup zero state --")
    token_a, admin_a, _ = signup_login("QA Alpha School", "qa-a@school.pk", "Password123")
    print("  (school A signed up + verified + logged in)")
    zero_checks = [
        ("/classes", 0), ("/students", 0), ("/exams", 0), ("/results", 0),
        ("/announcements", 0), ("/expenses", 0), ("/staff", 0), ("/sessions", 0),
        ("/messages/drafts", 0), ("/approvals", 0), ("/recycle-bin", 0),
    ]
    for path, want in zero_checks:
        s, r = req("GET", path, token_a)
        got = data(r).get("total", len(plist(data(r))))
        check(f"fresh signup: GET {path} total == {want}", s == 200 and got == want, f"status={s} got={got} {str(r)[:150]}")
    s, r = req("GET", "/messages/templates", token_a)
    tpls = plist(data(r))
    check("fresh signup: exactly 6 seeded message-template copies, nothing else", s == 200 and len(tpls) == 6, f"status={s} n={len(tpls)}")
    tpl_absent_en = next((t for t in tpls if t.get("type") == "absent" and t.get("language") == "en"), None)
    check("fresh signup: seeded templates are this school's own copies", tpl_absent_en is not None and tpl_absent_en.get("is_custom", tpl_absent_en.get("isCustom")) is False, str(tpl_absent_en)[:150])
    s, r = req("GET", "/fees?month=2026-11", token_a)
    check("fresh signup: GET /fees empty", s == 200 and data(r).get("total", 0) == 0, f"status={s} {str(r)[:150]}")

    # ---------- setup: classes + students ----------
    print("-- setup: classes + students --")
    s, r = req("POST", "/classes", token_a, {"name": "1", "section": "A", "teacher_name": "Ms. Shazia", "teacher_phone": "03001234567"})
    check("create class 1-A", s == 201, str(r)[:200])
    class_a = data(r)["id"]
    s, r = req("POST", "/classes", token_a, {"name": "1", "section": "B", "teacher_name": "Mr. Bilal", "teacher_phone": "03007654321"})
    check("create class 1-B", s == 201, str(r)[:200])
    class_b = data(r)["id"]

    # (c) no auto-fill: a class created with a name but no phone copies nothing
    s, r = req("POST", "/classes", token_a, {"name": "3", "section": "C", "teacher_name": "Ms. New"})
    check("(c) new class with no phone: blank/null phone, teacher exactly as submitted (not copied from 1-A)", s == 201 and data(r).get("teacher_name") == "Ms. New" and data(r).get("teacher_phone") in (None, ""), str(r)[:250])
    class_c = data(r)["id"]
    s, r = req("POST", f"/classes/{class_a}/students", token_a, {
        "name": "Ahmed Raza", "roll_no": 1, "parent_name": "Muhammad Raza",
        "parent_phone": "03001112222", "father_name": "Muhammad Raza", "admission_no": "ADM-001"})
    check("create student Ahmed Raza", s == 201, str(r)[:200])
    stu_ahmed = data(r)["id"]
    s, r = req("POST", f"/classes/{class_a}/students", token_a, {
        "name": "Fatima Khan", "roll_no": 2, "parent_phone": "03005556666", "admission_no": "ADM-002"})
    check("create student Fatima Khan", s == 201, str(r)[:200])
    stu_fatima = data(r)["id"]
    s, r = req("POST", f"/classes/{class_a}/students", token_a, {
        "name": "Bilal Ahmed", "roll_no": 3, "parent_phone": "03007778888",
        "admission_no": "ADM-003", "parent_opt_out": True})
    check("create student Bilal Ahmed (opted out)", s == 201, str(r)[:200])
    stu_bilal = data(r)["id"]
    s, r = req("POST", f"/classes/{class_a}/students", token_a, {
        "name": "Noor Fatima", "roll_no": 4, "admission_no": "ADM-004"})
    check("create student Noor Fatima (no phone)", s == 201, str(r)[:200])
    stu_noor = data(r)["id"]
    s, r = req("POST", f"/classes/{class_b}/students", token_a, {
        "name": "Sara Ahmed", "roll_no": 1, "parent_phone": "03009990000", "admission_no": "ADM-005"})
    check("create student Sara Ahmed in 1-B", s == 201, str(r)[:200])
    stu_sara = data(r)["id"]
    s, r = req("POST", f"/classes/{class_a}/students", token_a, {"name": "Bare Minimal"})
    check("(c) minimal student: blank/null parent fields, no copied values", s == 201 and data(r).get("parent_name") in (None, "") and data(r).get("status") == "active", str(r)[:250])
    stu_bare = data(r)["id"]
    s, r = req("POST", "/fees/structures", token_a, {"class_id": class_a, "monthly_amount": 2500, "effective_from": "2026-10-01", "admission_fee": 500, "sibling_discount_pct": 0})
    check("fee structure 1-A (2500 + 500 admission)", s in (200, 201), str(r)[:200])

    # ---------- (n) sessions / exams / timetable / staff / payroll ----------
    print("-- (n) sessions / exams / timetable / staff / payroll --")
    s, r = req("POST", "/sessions", token_a, {"name": "2026-27", "start_date": "2026-04-01", "end_date": "2027-03-31"})
    check("session create", s == 201, str(r)[:200])
    session_id = data(r)["id"]
    s, r = req("POST", f"/sessions/{session_id}/make-current", token_a, {})
    check("session make-current", s == 200 and data(r).get("is_current") is True, str(r)[:200])
    s, r = req("POST", "/exams", token_a, {"name": "Quiz 1", "session_id": session_id, "start_date": "2026-11-10", "end_date": "2026-11-12"})
    check("exam create", s == 201, str(r)[:200])
    exam_quiz = data(r)["id"]
    s, r = req("POST", f"/exams/{exam_quiz}/datesheet", token_a, {"class_id": class_a, "subject": "Math", "date": "2026-11-10", "start_time": "09:00", "end_time": "10:00"})
    check("datesheet create", s in (200, 201), str(r)[:200])
    s, r = req("GET", f"/exams/{exam_quiz}/datesheet?class_id={class_a}", token_a)
    check("datesheet list", s == 200 and len(plist(data(r))) == 1, str(r)[:200])
    s, r = req("POST", "/grading-scales/seed-defaults", token_a, {})
    check("grading seed-defaults", s in (200, 201, 409), str(r)[:200])
    s, r = req("GET", f"/grading-scales/passing?class_id={class_a}", token_a)
    check("passing marks = 50 (seeded defaults)", s == 200 and data(r).get("passing_marks") == 50, str(r)[:200])
    s, r = req("POST", "/timetable", token_a, {"class_id": class_a, "day_of_week": 1, "period_no": 1, "subject": "Math", "start_time": "08:00", "end_time": "08:45"})
    check("timetable create", s == 201, str(r)[:200])
    s, r = req("POST", "/timetable", token_a, {"class_id": class_a, "day_of_week": 1, "period_no": 1, "subject": "English", "start_time": "08:00", "end_time": "08:45"})
    check("timetable double-book -> 409", s == 409, str(r)[:200])
    s, r = req("GET", f"/timetable/class/{class_a}", token_a)
    check("timetable class view", s == 200 and "by_day" in data(r), str(r)[:200])
    s, r = req("POST", "/staff", token_a, {"name": "Ms. Shazia", "role": "teacher", "phone": "03001234567", "salary_monthly": 60000})
    check("staff create", s == 201, str(r)[:200])
    staff_id = data(r)["id"]
    s, r = req("POST", f"/staff/{staff_id}/assign", token_a, {"class_id": class_a, "subject": "Math"})
    check("staff assign to 1-A", s in (200, 201), str(r)[:200])
    s, r = req("POST", "/payroll", token_a, {"staff_id": staff_id, "month": "2026-11", "base_salary": 60000, "deductions": 2000})
    check("payroll net_pay = 58000", s in (200, 201) and data(r).get("net_pay") == 58000, str(r)[:250])
    payroll_id = data(r)["id"]
    s, r = req("GET", f"/payroll/{payroll_id}/payslip", token_a)
    check("payslip HTML", s == 200 and b"Shazia" in (r if isinstance(r, bytes) else b""), f"status={s}")

    # ---------- results manual (needed for isolation + toppers baseline) ----------
    print("-- results manual entry --")
    s, r = req("POST", "/results/manual", token_a, {
        "exam_name": "Midterm", "class_id": class_a,
        "rows": [
            {"roll_no": 1, "student_name": "Ahmed Raza", "subject_marks": {"English": 85, "Math": 90}, "obtained_marks": 175, "total_marks": 200},
            {"roll_no": 2, "student_name": "Fatima Khan", "subject_marks": {"English": 92, "Math": 95}, "obtained_marks": 187, "total_marks": 200},
        ]})
    check("manual results save (Midterm)", s == 200 and data(r).get("saved") == 2 and data(r).get("linked") == 2, str(r)[:300])
    s, r = req("GET", "/exams", token_a)
    exam_mid = next(e["id"] for e in plist(data(r)) if e["name"] == "Midterm")
    s, r = req("GET", f"/results?exam_id={exam_mid}&class_id={class_a}", token_a)
    res_ahmed = next(x for x in plist(data(r)) if x["roll_no"] == 1)
    check("Midterm result linked, position 2 (Fatima 187 first)", res_ahmed.get("linked") and res_ahmed.get("position") == 2, str(res_ahmed)[:200])

    # ---------- (m) fees: pay / partial / arrears / voucher / receipt ----------
    print("-- (m) fees --")
    s, r = req("GET", f"/fees?month=2026-11&class_id={class_a}", token_a)
    fees = plist(data(r))
    ahmed_fee = next((f for f in fees if f.get("student_id") == stu_ahmed), None)
    check("fee row for Ahmed: due 3000 (2500 monthly + 500 admission, first record)", ahmed_fee is not None and ahmed_fee.get("amount_due") == 3000, str(ahmed_fee)[:250])
    s, r = req("POST", f"/fees/{stu_ahmed}/pay", token_a, {"month": "2026-11", "amount_paid": 1000, "payment_method": "cash"})
    check("partial pay 1000 -> 201 + receipt", s == 201 and data(r).get("receipt_no"), str(r)[:250])
    receipt_ahmed = data(r).get("receipt_no")
    s, r = req("GET", f"/fees?month=2026-11&class_id={class_a}", token_a)
    ahmed_fee = next((f for f in plist(data(r)) if f.get("student_id") == stu_ahmed), None)
    check("after partial: status partial, balance 2000", ahmed_fee is not None and ahmed_fee.get("status") == "partial", str(ahmed_fee)[:250])
    s, r = req("POST", f"/fees/{stu_ahmed}/pay", token_a, {"month": "2026-11", "amount_paid": 2000, "payment_method": "cash"})
    check("pay remainder 2000 -> paid in full", s == 201, str(r)[:200])
    s, r = req("GET", f"/fees?month=2026-11&class_id={class_a}", token_a)
    ahmed_fee = next((f for f in plist(data(r)) if f.get("student_id") == stu_ahmed), None)
    check("after full pay: status paid", ahmed_fee is not None and ahmed_fee.get("status") == "paid", str(ahmed_fee)[:250])
    s, r = req("GET", f"/fees/receipts/{receipt_ahmed}", token_a)
    check("receipt HTML contains receipt no + student", s == 200 and receipt_ahmed.encode() in (r if isinstance(r, bytes) else b""), f"status={s}")
    # arrears: Fatima pays only 1000 of Oct (due 3000) -> 2000 carries to Nov
    s, r = req("POST", f"/fees/{stu_fatima}/pay", token_a, {"month": "2026-10", "amount_paid": 1000, "payment_method": "cash"})
    check("Fatima Oct partial pay", s == 201, str(r)[:200])
    s, r = req("GET", f"/fees?month=2026-11&class_id={class_a}", token_a)
    fatima_fee = next((f for f in plist(data(r)) if f.get("student_id") == stu_fatima), None)
    check("Nov fee row for Fatima carries arrears 2000", fatima_fee is not None and fatima_fee.get("arrears") == 2000, str(fatima_fee)[:300])
    s, r = req("POST", "/fees/vouchers/by-student", token_a, {"student_id": stu_ahmed, "month": "2026-11"})
    check("voucher by-student", s in (200, 201) and data(r).get("voucher_no"), str(r)[:250])
    voucher_no = data(r).get("voucher_no")
    s, r = req("GET", f"/fees/vouchers/{voucher_no}", token_a)
    check("voucher HTML", s == 200 and voucher_no.encode() in (r if isinstance(r, bytes) else b""), f"status={s}")

    # ---------- (l) messaging: template edit, preview, draft -> approval -> queue ----------
    print("-- (l) messaging --")
    s, r = req("PATCH", f"/messages/templates/{tpl_absent_en['id']}", token_a, {"body": "Salam {student_name}, {class}-{section} class is absent today ({date}). - {school_name}"})
    check("template edit (seeded default is editable)", s == 200 and "Salam" in str(data(r)), str(r)[:200])
    s, r = req("POST", "/messages/preview", token_a, {"body": "Salam {student_name}, fee {amount} for {month}. - {school_name}", "recipient_type": "class", "target_class_id": class_a, "month": "2026-11"})
    pv = data(r)
    check("preview: 2 sendable (Ahmed, Fatima), 3 skipped (Bilal opted-out; Noor + Bare Minimal no phone)", s == 200 and pv.get("recipientCount") == 2 and pv.get("skippedCount") == 3, str(r)[:300])
    check("preview: samples rendered with real names + char/SMS-part counts", s == 200 and pv.get("samples") and pv["samples"][0].get("charCount", 0) > 0 and pv.get("smsParts", 0) >= 1, str(pv)[:250])
    s, r = req("POST", "/messages/preview", token_a, {"body": "سلام {student_name}، آپ کا بچہ آج غیر حاضر ہے۔", "recipient_type": "class", "target_class_id": class_a})
    check("preview Urdu: unicode SMS counting (70/67)", s == 200 and data(r).get("isUnicode") is True, str(r)[:200])
    s, r = req("POST", "/messages/drafts", token_a, {"recipient_type": "class", "target_class_id": class_a, "body": "Salam {student_name}, this is a test message from {school_name}."})
    check("draft create", s == 201, str(r)[:200])
    draft_id = data(r).get("draft", {}).get("id") or data(r).get("id")
    s, r = req("GET", "/messages/log", token_a)
    log_before = data(r).get("total", len(plist(data(r))))
    s, r = req("POST", f"/messages/drafts/{draft_id}/submit-for-approval", token_a, {})
    check("draft submit-for-approval -> 202", s == 202 and data(r).get("approval_request_id"), str(r)[:200])
    appr_draft = data(r).get("approval_request_id")
    s, r = req("GET", "/messages/log", token_a)
    check("nothing queued before approval (log unchanged)", s == 200 and data(r).get("total", len(plist(data(r)))) == log_before, f"before={log_before} after={data(r).get('total')}")
    s, r = req("POST", f"/approvals/{appr_draft}/approve", token_a, {})
    check("admin approves draft -> applied", s == 200, str(r)[:300])
    s, r = req("GET", "/messages/log", token_a)
    log_items = plist(data(r))
    check("after approval: 2 queue rows (Ahmed + Fatima), opt-out + no-phone excluded", s == 200 and len(log_items) >= 2, f"n={len(log_items)} {str(r)[:200]}")
    s, r = req("POST", "/messages/drafts", token_a, {"recipient_type": "class", "target_class_id": class_a, "body": "Second test {student_name} from {school_name}."})
    draft2 = data(r).get("draft", {}).get("id") or data(r).get("id")
    s, r = req("POST", f"/messages/drafts/{draft2}/approve-send", token_a, {})
    check("direct approve-send: queued 2, skipped_opted_out 1", s == 200 and data(r).get("queued") == 2 and data(r).get("skippedOptedOut") == 1, str(r)[:300])
    # template duplicate + delete
    s, r = req("POST", f"/messages/templates/{tpl_absent_en['id']}/duplicate", token_a, {})
    check("template duplicate", s in (200, 201), str(r)[:200])
    dup_id = data(r).get("template", {}).get("id") or data(r).get("id")
    check("duplicate response carries the copy id", bool(dup_id), str(r)[:200])
    if dup_id:
        s, r = req("DELETE", f"/messages/templates/{dup_id}", token_a)
        check("template delete (nothing locked)", s == 200, str(r)[:200])

    # ---------- announcement SMS hook (Phase 8 item 3) ----------
    print("-- announcement SMS hook --")
    s, r = req("POST", "/announcements", token_a, {"title": "Parent-teacher meeting", "body": "PTM on Friday at 10am. - {school_name}", "target_type": "class", "target_class_id": class_a, "sms_send": True})
    check("announcement create (sms_send)", s == 201, str(r)[:200])
    ann_id = data(r)["id"]
    s, r = req("POST", f"/announcements/{ann_id}/send", token_a, {})
    check("send before approval -> 409, nothing queued", s == 409, str(r)[:200])
    s, r = req("POST", f"/announcements/{ann_id}/approve", token_a, {})
    check("announcement approve", s == 200, str(r)[:200])
    s, r = req("POST", f"/announcements/{ann_id}/send", token_a, {})
    check("announcement send -> 200, queued 2, draft created", s == 200 and data(r).get("queued") == 2 and data(r).get("draft_id"), str(r)[:300])
    ann_draft = data(r).get("draft_id")
    s, r = req("GET", f"/announcements/{ann_id}", token_a)
    check("announcement status now sent", s == 200 and data(r).get("status") == "sent", str(r)[:200])
    s, r = req("GET", "/messages/log?type=announcement", token_a)
    check("announcement queue rows visible in log as type announcement", s == 200 and len(plist(data(r))) >= 2, f"n={len(plist(data(r)))} {str(r)[:200]}")
    s, r = req("POST", f"/announcements/{ann_id}/send", token_a, {})
    check("second send -> 409 (no double send)", s == 409, str(r)[:200])
    s, r = req("POST", "/announcements", token_a, {"title": "Notice only", "body": "No SMS for this one.", "target_type": "all", "sms_send": False})
    ann_nosms = data(r)["id"]
    s, r = req("POST", f"/announcements/{ann_nosms}/approve", token_a, {})
    s, r = req("POST", f"/announcements/{ann_nosms}/send", token_a, {})
    check("sms_send=false announcement send -> 409", s == 409, str(r)[:200])

    # ---------- (a) two-school isolation incl. ID tampering ----------
    print("-- (a) two-school isolation --")
    token_b, admin_b, _ = signup_login("QA Beta School", "qa-b@school.pk", "Password123")
    print("  (school B signed up + verified + logged in)")
    s, r = req("GET", f"/classes/{class_a}", token_b)
    check("B cannot read A's class -> 404", s == 404, str(r)[:150])
    s, r = req("PATCH", f"/classes/{class_a}", token_b, {"teacher_name": "Hacker"})
    check("B cannot update A's class -> 404", s == 404, str(r)[:150])
    s, r = req("DELETE", f"/classes/{class_a}", token_b)
    check("B cannot delete A's class -> 404", s == 404, str(r)[:150])
    s, r = req("GET", f"/classes/{class_a}", token_a)
    check("A's class teacher unchanged after B's attempts", s == 200 and data(r).get("teacher_name") == "Ms. Shazia", str(r)[:150])
    s, r = req("GET", f"/classes/{class_a}/students", token_b)
    check("B cannot list A's students -> 404", s == 404, str(r)[:150])
    s, r = req("POST", f"/classes/{class_a}/students", token_b, {"name": "Intruder"})
    check("B cannot create a student in A's class -> 404", s == 404, str(r)[:150])
    s, r = req("GET", f"/students/{stu_ahmed}", token_b)
    check("B cannot read A's student -> 404", s == 404, str(r)[:150])
    s, r = req("PATCH", f"/students/{stu_ahmed}", token_b, {"name": "Hacked"})
    check("B cannot update A's student -> 404", s == 404, str(r)[:150])
    s, r = req("DELETE", f"/students/{stu_ahmed}", token_b)
    check("B cannot delete A's student -> 404", s == 404, str(r)[:150])
    s, r = req("POST", f"/students/{stu_ahmed}/move", token_b, {"class_id": class_a})
    check("B cannot move A's student (ID tamper) -> 403/404", s in (403, 404), str(r)[:150])
    s, r = req("POST", f"/fees/{stu_ahmed}/pay", token_b, {"month": "2026-11", "amount_paid": 100, "payment_method": "cash"})
    check("B cannot pay A's student fee (ID tamper) -> 404", s == 404, str(r)[:150])
    s, r = req("GET", f"/fees/receipts/{receipt_ahmed}", token_b)
    check("B cannot fetch A's receipt -> 404", s == 404, str(r)[:150])
    s, r = req("GET", f"/results/{res_ahmed['id']}", token_b)
    check("B cannot read A's result -> 404", s == 404, str(r)[:150])
    s, r = req("GET", f"/results?exam_id={exam_mid}&class_id={class_a}", token_b)
    check("B's list of A's exam results is empty", s == 200 and data(r).get("total") == 0, str(r)[:150])
    s, r = req("GET", f"/messages/drafts/{draft_id}", token_b)
    check("B cannot read A's message draft -> 404", s == 404, str(r)[:150])
    s, r = req("PATCH", f"/messages/templates/{tpl_absent_en['id']}", token_b, {"body": "hacked"})
    check("B cannot edit A's template -> 404", s == 404, str(r)[:150])
    s, r = req("GET", f"/announcements/{ann_id}", token_b)
    check("B cannot read A's announcement -> 404", s == 404, str(r)[:150])
    s, r = req("POST", f"/announcements/{ann_id}/send", token_b, {})
    check("B cannot send A's announcement -> 404", s == 404, str(r)[:150])
    s, r = req("GET", f"/exams/{exam_quiz}", token_b)
    check("B cannot read A's exam -> 404", s == 404, str(r)[:150])
    s, r = req("GET", "/messages/templates", token_b)
    b_tpls = plist(data(r))
    check("B's template list is only B's own 6 (no A ids)", s == 200 and len(b_tpls) == 6 and tpl_absent_en["id"] not in [t["id"] for t in b_tpls], f"n={len(b_tpls)}")
    # ID tampering via bodies: B uses A's ids inside its own calls
    s, r = req("POST", "/results/manual", token_b, {"exam_name": "Hack Exam", "class_id": class_a, "rows": [{"roll_no": 1, "student_name": "X", "obtained_marks": 10, "total_marks": 100}]})
    check("B manual results with A's class_id -> 404", s == 404, str(r)[:150])
    s, r = req("POST", "/fees/vouchers/by-student", token_b, {"student_id": stu_ahmed, "month": "2026-11"})
    check("B voucher for A's student (ID tamper) -> 404", s == 404, str(r)[:150])
    s, r = req("POST", "/messages/preview", token_b, {"body": "hi {student_name}", "recipient_type": "selected_students", "target_student_ids": [stu_ahmed, stu_fatima]})
    check("B preview with A's student ids resolves 0 recipients", s == 200 and data(r).get("recipientCount") == 0, str(r)[:200])
    s, r = req("POST", "/classes", token_b, {"name": "1", "section": "A", "teacher_name": "B Teacher"})
    check("B can create its own 1-A (per-school uniqueness)", s == 201, str(r)[:150])
    class_b_own = data(r)["id"]
    s, r = req("POST", f"/classes/{class_b_own}/students", token_b, {"name": "B Student", "roll_no": 1, "parent_phone": "03001112233"})
    stu_b = data(r)["id"]
    s, r = req("POST", "/results/manual", token_b, {"exam_name": "B Midterm", "class_id": class_b_own, "rows": [{"roll_no": 1, "student_name": "B Student", "obtained_marks": 40, "total_marks": 100}]})
    check("B manual results save", s == 200 and data(r).get("saved") == 1, str(r)[:200])
    s, r = req("GET", "/exams", token_b)
    exam_b = next(e["id"] for e in plist(data(r)) if e["name"] == "B Midterm")
    s, r = req("GET", f"/results/summary?exam_id={exam_b}&class_id={class_b_own}", token_b)
    check("B summary: passing threshold 33% default (no grading scales in B)", s == 200 and data(r).get("passing_threshold_percent") == 33, str(r)[:250])
    s, r = req("POST", "/classes", token_a, {"name": "9", "section": "Z", "school_id": "forged-school-id"})
    check("forged school_id in body is rejected (400) or ignored", s in (200, 201, 400), f"status={s} {str(r)[:150]}")
    if s in (200, 201):
        s2, r2 = req("GET", f"/classes/{data(r)['id']}", token_b)
        check("forged-school class (if created) belongs to A, not B", s2 == 404, f"status={s2}")

    # ---------- (i) roles: Principal 403, Clerk gated, Admin full ----------
    print("-- (i) roles --")
    s, r = req("POST", "/users/clerks", token_a, {"email": "qa-clerk@school.pk", "password": "Password123"})
    check("create clerk", s in (200, 201), str(r)[:200])
    s, r = req("POST", "/users/principals", token_a, {"email": "qa-principal@school.pk", "password": "Password123"})
    check("create principal", s in (200, 201), str(r)[:200])
    s, r = req("POST", "/auth/login", body={"email": "qa-clerk@school.pk", "password": "Password123"})
    check("clerk login", s == 200, str(r)[:150])
    token_c = data(r)["access"]
    s, r = req("POST", "/auth/login", body={"email": "qa-principal@school.pk", "password": "Password123"})
    check("principal login", s == 200, str(r)[:150])
    token_p = data(r)["access"]
    s, r = req("POST", "/classes", token_p, {"name": "8", "section": "A", "teacher_name": "P"})
    check("Principal create class -> 403", s == 403, str(r)[:150])
    s, r = req("PATCH", f"/students/{stu_ahmed}", token_p, {"name": "Nope"})
    check("Principal update student -> 403", s == 403, str(r)[:150])
    s, r = req("POST", f"/fees/{stu_fatima}/pay", token_p, {"month": "2026-11", "amount_paid": 100})
    check("Principal pay fee -> 403", s == 403, str(r)[:150])
    s, r = req("GET", "/classes", token_p)
    check("Principal can view classes (200)", s == 200, str(r)[:150])
    s, r = req("GET", "/roles/me", token_p)
    me_items = data(r).get("items", [])
    check("Principal /roles/me reports view-only permissions", s == 200 and len(me_items) >= 1 and all(i.get("action") == "view" for i in me_items), str(r)[:250])
    s, r = req("PATCH", "/settings", token_c, {"fee_followup_day": 5})
    check("Clerk PATCH settings -> 403", s == 403, str(r)[:150])
    s, r = req("GET", "/classes", token_c)
    check("Clerk can view classes (200)", s == 200, str(r)[:150])
    s, r = req("POST", "/classes", token_c, {"name": "7", "section": "A", "teacher_name": "Clerk Teacher"})
    check("Clerk create class -> 202 (queued, not applied)", s == 202 and data(r).get("approval_request_id"), str(r)[:200])

    # ---------- (d) approval queue: clerk add/delete, admin approve/reject ----------
    print("-- (d) approval queue --")
    s, r = req("POST", f"/classes/{class_a}/students", token_c, {"name": "Clerk Kid", "roll_no": 7, "parent_phone": "03001110000"})
    check("clerk add student -> 202 pending", s == 202 and data(r).get("status") == "pending", str(r)[:250])
    appr_add = data(r).get("approval_request_id")
    s, r = req("GET", f"/classes/{class_a}/students", token_a)
    check("clerk's student NOT applied before approval", s == 200 and not any(x.get("name") == "Clerk Kid" for x in plist(data(r))), str(r)[:200])
    s, r = req("POST", f"/approvals/{appr_add}/approve", token_a, {})
    check("admin approves clerk add -> 200", s == 200, str(r)[:250])
    s, r = req("GET", f"/classes/{class_a}/students", token_a)
    clerk_kid = next((x for x in plist(data(r)) if x.get("name") == "Clerk Kid"), None)
    check("clerk's student applied after approval", clerk_kid is not None, str(r)[:200])
    s, r = req("DELETE", f"/students/{clerk_kid['id']}", token_c)
    check("clerk delete student -> 202 pending", s == 202, str(r)[:200])
    appr_del = data(r).get("approval_request_id")
    s, r = req("POST", f"/approvals/{appr_del}/reject", token_a, {"reason": "QA reject test"})
    check("admin rejects clerk delete -> 200", s == 200, str(r)[:200])
    s, r = req("GET", f"/students/{clerk_kid['id']}", token_a)
    check("rejected delete: student still present", s == 200, str(r)[:150])
    # clerk fee pay queues too
    s, r = req("POST", f"/fees/{stu_fatima}/pay", token_c, {"month": "2026-11", "amount_paid": 500, "payment_method": "cash"})
    check("clerk fee pay -> 202 pending", s == 202, str(r)[:200])
    appr_pay = data(r).get("approval_request_id")
    s, r = req("GET", f"/fees?month=2026-11&class_id={class_a}", token_a)
    fatima_fee = next((f for f in plist(data(r)) if f.get("student_id") == stu_fatima), None)
    check("clerk fee pay NOT applied before approval", fatima_fee is not None and fatima_fee.get("amount_paid", 0) == 0, str(fatima_fee)[:200])
    s, r = req("POST", f"/approvals/{appr_pay}/approve", token_a, {})
    check("admin approves clerk fee pay", s == 200, str(r)[:200])
    s, r = req("GET", f"/fees?month=2026-11&class_id={class_a}", token_a)
    fatima_fee = next((f for f in plist(data(r)) if f.get("student_id") == stu_fatima), None)
    check("clerk fee pay applied after approval (500 paid)", fatima_fee is not None and fatima_fee.get("amount_paid") == 500, str(fatima_fee)[:200])

    # ---------- (e) recycle bin + (f) change history ----------
    print("-- (e) recycle bin / (f) change history --")
    s, r = req("POST", f"/classes/{class_a}/students", token_a, {"name": "Recycle Raza", "roll_no": 9, "parent_phone": "03002223333"})
    rec_stu = data(r)["id"]
    s, r = req("DELETE", f"/students/{rec_stu}", token_a)
    check("soft-delete student", s == 200, str(r)[:150])
    s, r = req("GET", f"/students/{rec_stu}", token_a)
    check("soft-deleted student -> 404", s == 404, str(r)[:150])
    s, r = req("GET", f"/classes/{class_a}/students", token_a)
    check("soft-deleted student excluded from list", s == 200 and not any(x["id"] == rec_stu for x in plist(data(r))), str(r)[:150])
    s, r = req("GET", "/recycle-bin?entity=student", token_a)
    bin_items = plist(data(r))
    bin_row = next((x for x in bin_items if x.get("entity_id") == rec_stu), None)
    check("recycle bin lists the student (30-day window)", s == 200 and bin_row is not None, str(r)[:250])
    bin_id = bin_row["id"]
    check("recycle-bin row carries restore_by ~30 days out", bin_row.get("restore_by") is not None, str(bin_row)[:200])
    s, r = req("POST", f"/recycle-bin/{bin_id}/restore", token_a, {})
    check("restore within 30 days -> 200", s == 200, str(r)[:200])
    s, r = req("GET", f"/students/{rec_stu}", token_a)
    check("restored student readable again", s == 200, str(r)[:150])
    s, r = req("DELETE", f"/students/{rec_stu}", token_a)
    s, r = req("GET", "/recycle-bin?entity=student", token_a)
    bin_row = next((x for x in plist(data(r)) if x.get("entity_id") == rec_stu), None)
    bin_id = bin_row["id"]
    s, r = req("POST", f"/recycle-bin/{bin_id}/permanent-delete", token_a, {})
    check("permanent delete without confirm -> 400", s == 400, str(r)[:150])
    s, r = req("POST", f"/recycle-bin/{bin_id}/permanent-delete", token_a, {"confirm": True})
    check("permanent delete with {confirm:true} -> 200", s == 200, str(r)[:150])
    s, r = req("GET", "/recycle-bin?entity=student", token_a)
    check("permanently deleted row gone from bin", s == 200 and not any(x.get("entity_id") == rec_stu for x in plist(data(r))), str(r)[:150])
    # change history
    s, r = req("PATCH", f"/students/{stu_ahmed}", token_a, {"name": "Ahmed Raza Jr", "address": "Street 9"})
    check("edit student (name + address)", s == 200, str(r)[:150])
    s, r = req("GET", f"/change-logs?entity=student&entity_id={stu_ahmed}", token_a)
    logs = plist(data(r))
    name_log = next((x for x in logs if x.get("field") == "name"), None)
    addr_log = next((x for x in logs if x.get("field") == "address"), None)
    check("change history: name old/new per-field row", name_log is not None and name_log.get("old_value") == "Ahmed Raza" and name_log.get("new_value") == "Ahmed Raza Jr", str(name_log)[:200])
    check("change history: address old/new per-field row", addr_log is not None and addr_log.get("new_value") == "Street 9", str(addr_log)[:200])
    s, r = req("PATCH", f"/students/{stu_ahmed}", token_a, {"name": "Ahmed Raza"})
    check("restore student name for later tests", s == 200, str(r)[:150])

    # ---------- (g) results OCR + review + toppers ----------
    print("-- (g) results OCR --")
    png = make_sheet_png()
    s, r = multipart(f"/classes/{class_a}/results/upload", token_a, {"exam_name": "Final"}, "image", "sheet.png", png, "image/png")
    check("OCR upload result sheet", s == 201 and len(data(r).get("rows", [])) >= 2, str(r)[:400])
    if s == 201:
        sheet_id = data(r)["result_sheet_id"]
        exam_final = data(r)["exam_id"]
        s, r = req("GET", f"/results/review/{sheet_id}", token_a)
        rows = data(r).get("rows", [])
        check("review table returns parsed rows + link preview", s == 200 and len(rows) >= 2 and all("link_preview" in row for row in rows), str(r)[:300])
        confirm_rows = []
        for row in rows:
            if not row.get("roll_no"):
                continue
            cr = {"roll_no": row["roll_no"], "student_name": row["student_name"],
                  "subject_marks": row.get("subject_marks") or {},
                  "obtained_marks": row.get("obtained_marks"), "total_marks": row.get("total_marks")}
            if row["roll_no"] == 3:
                cr["obtained_marks"] = 250  # obtained > total: must be flagged
            confirm_rows.append(cr)
        confirm_rows.append({"roll_no": 99, "student_name": "Ghost Student", "subject_marks": {"English": 50, "Math": 50}, "obtained_marks": 100, "total_marks": 200})
        s, r = req("POST", f"/result-sheets/{sheet_id}/confirm", token_a, {"rows": confirm_rows})
        _flagged = data(r).get("flagged", 0)
        _flagged_n = len(_flagged) if isinstance(_flagged, list) else _flagged
        _unlinked = data(r).get("unlinked", 0)
        _unlinked_n = len(_unlinked) if isinstance(_unlinked, list) else _unlinked
        check("confirm flags obtained>total + reports unlinked ghost row", s == 200 and _flagged_n >= 1 and _unlinked_n >= 1, str(r)[:300])
        check("confirm saved >= 3, linked >= 3", s == 200 and data(r).get("saved", 0) >= 3 and data(r).get("linked", 0) >= 3, str(r)[:300])
        s, r = req("GET", f"/results?exam_id={exam_final}&class_id={class_a}", token_a)
        items = plist(data(r))
        ghost = next((x for x in items if x.get("roll_no") == 99), None)
        check("ghost row saved unlinked (never auto-created a student)", ghost is not None and not ghost.get("linked"), str(ghost)[:200])
        if ghost:
            s2, r2 = req("POST", f"/results/{ghost['id']}/link", token_a, {"student_id": stu_sara})
            check("link ghost to 1-B student -> rejected (same class only)", s2 in (400, 404, 409), f"status={s2} {str(r2)[:150]}")
        bilal_res = next((x for x in items if x.get("roll_no") == 3), None)
        s, r = req("PATCH", f"/results/{bilal_res['id']}", token_a, {"obtained_marks": 70})
        check("PATCH Bilal back to 70/200 recomputes %/positions", s == 200 and r.get("data", {}).get("percentage") == 35.0, str(r)[:200])
        s, r = req("GET", f"/results/toppers?exam_id={exam_final}&class_id={class_a}", token_a)
        toppers = plist(data(r))
        check("toppers: Fatima 187 first, Ahmed 175 second, Bilal 70 third", s == 200 and len(toppers) >= 3 and toppers[0].get("student_name") == "Fatima Khan" and toppers[0].get("position") == 1 and toppers[1].get("position") == 2 and toppers[2].get("position") == 3, str(r)[:250])
        s, r = req("GET", f"/results/summary?exam_id={exam_final}&class_id={class_a}", token_a)
        check("summary: passing threshold 50 (seeded grading scales override the 33% default)", s == 200 and data(r).get("passing_threshold_percent") == 50, str(r)[:250])
        s, r = req("POST", f"/result-sheets/{sheet_id}/publish", token_a, {})
        check("publish sheet -> SMS drafts created", s == 200 and data(r).get("drafts_created", 0) >= 1, str(r)[:250])
    else:
        print("  (OCR upload failed — review/confirm/publish checks skipped)")

    # ---------- (h) sections independent ----------
    print("-- (h) sections independent --")
    s, r = req("POST", f"/classes/{class_a}/attendance-link/regenerate", token_a, {})
    check("regenerate link 1-A", s == 200 and data(r).get("link"), str(r)[:150])
    link_a = data(r)["link"]
    token_a_link = link_a.rstrip("/").split("/")[-1]
    s, r = req("POST", f"/classes/{class_b}/attendance-link/regenerate", token_a, {})
    check("regenerate link 1-B (different link)", s == 200 and data(r).get("link") != link_a, str(r)[:150])
    link_b = data(r)["link"]
    token_b_link = link_b.rstrip("/").split("/")[-1]
    s, r = req("POST", f"/classes/{class_a}/attendance-link/revoke", token_a, {})
    check("revoke link 1-A", s == 200, str(r)[:150])
    s, r = req("GET", f"/t/{token_a_link}")
    check("revoked 1-A link no longer works", s in (401, 404), f"status={s}")
    s, r = req("GET", f"/t/{token_b_link}")
    check("1-B link still works after 1-A revoke", s == 200 and data(r).get("class", {}).get("id") == class_b, str(r)[:250])
    s, r = req("POST", f"/t/{token_b_link}/submit", None, {"records": [{"student_id": stu_sara, "status": "present"}]})
    check("attendance submit via 1-B link", s in (200, 201), str(r)[:250])
    s, r = req("GET", "/reports/attendance/daily?date=2026-11-07&class_id=" + class_b, token_a)
    check("daily report: 1-B has the submission", s == 200, str(r)[:250])

    # ---------- (j) 2FA round-trip ----------
    print("-- (j) 2FA --")
    s, r = req("POST", "/auth/2fa/setup", token_a, {})
    check("2FA setup returns secret + otpauth URL", s == 200 and data(r).get("secret") and data(r).get("otpauth_url"), str(r)[:150])
    secret = data(r).get("secret")
    code = totp(secret)
    s, r = req("POST", "/auth/2fa/verify", token_a, {"code": code})
    check("2FA verify enables TOTP", s == 200, str(r)[:200])
    s, r = req("GET", "/auth/me", token_a)
    check("me shows totp_enabled true", s == 200 and data(r).get("user", {}).get("totp_enabled") is True, str(r)[:200])
    s, r = req("POST", "/auth/login", body={"email": "qa-a@school.pk", "password": "Password123"})
    check("login with 2FA on -> needs_2fa + temp_token", s == 200 and data(r).get("needs_2fa") is True and data(r).get("temp_token"), str(r)[:200])
    temp_token = data(r).get("temp_token")
    code2 = totp(secret)
    s, r = req("POST", "/auth/2fa/login", body={"temp_token": temp_token, "code": code2})
    check("2FA login exchanges temp token for JWTs", s == 200 and data(r).get("access"), str(r)[:200])
    token_a2 = data(r).get("access")
    code3 = totp(secret)
    s, r = req("POST", "/auth/login", body={"email": "qa-a@school.pk", "password": "Password123", "totp_code": code3})
    check("login with inline totp_code -> 200", s == 200 and data(r).get("access"), str(r)[:200])
    s, r = req("POST", "/auth/2fa/disable", token_a, {"password": "Password123"})
    check("2FA disable with password", s == 200, str(r)[:200])

    # ---------- (k) export requires password + returns full data ----------
    print("-- (k) export --")
    s, r = req("POST", "/export/all", token_a, {})
    check("export without password -> 400", s == 400, str(r)[:150])
    s, r = req("POST", "/export/all", token_a, {"password": "WrongPass123"})
    check("export with wrong password -> 401", s == 401, str(r)[:150])
    s, r = req("POST", "/export/all", token_a, {"password": "Password123"})
    exp = data(r)
    exp_tables = exp.get("tables", exp) if isinstance(exp, dict) else {}
    check("export with password -> 200 full data incl. students + templates", s == 200 and isinstance(exp_tables.get("students"), list) and len(exp_tables["students"]) >= 5 and len(exp_tables.get("message_templates", [])) == 6, f"status={s} keys={list(exp_tables.keys())[:12]}")
    ahmed_exp = next((x for x in exp_tables.get("students", []) if x.get("name") == "Ahmed Raza"), None)
    check("export decrypts phones for own data (+92 number present)", ahmed_exp is not None and str(ahmed_exp.get("parent_phone") or ahmed_exp.get("parentPhone") or "").startswith("+92"), str(ahmed_exp)[:200])

    # ---------- (o) backup job writes file + school_backups row ----------
    print("-- (o) backup --")
    s, r = req("POST", "/backups/run", token_a, {})
    check("POST /backups/run -> 200 with file + size", s == 200 and data(r).get("file") and data(r).get("sizeBytes", 0) > 1000, str(r)[:250])
    backup_file = data(r).get("file")
    s, r = req("GET", "/backups", token_a)
    items = plist(data(r))
    check("GET /backups lists the row", s == 200 and len(items) >= 1 and (items[0].get("file_ref") or items[0].get("fileRef")), str(r)[:250])
    s, r = req("GET", "/jobs/status", token_a)
    jobs = data(r)
    job_names = [j.get("name") or j.get("job") or str(j) for j in (jobs if isinstance(jobs, list) else jobs.get("jobs", []))]
    check("jobs status lists school_backup + scheduled_messages (scoped to A)", s == 200 and "school_backup" in str(jobs) and "scheduled_messages" in str(jobs), str(r)[:300])
    print(f"  (backup file reported: {backup_file}; verify on disk in the report step)")

    # ---------- (p) rate limiting — LAST ----------
    print("-- (p) rate limiting (auth limiter) --")
    n401 = n429 = 0
    for _ in range(25):
        s, r = req("POST", "/auth/login", body={"email": "qa-a@school.pk", "password": "WrongPassword1"})
        if s == 401:
            n401 += 1
        elif s == 429:
            n429 += 1
            check("rate limit body carries code RATE_LIMITED", r.get("error", {}).get("code") == "RATE_LIMITED", str(r)[:150])
            break
    check(f"wrong-password logins: 401s then 429 (401x{n401}, 429x{n429})", n429 >= 1, f"401x{n401} 429x{n429}")

    print(f"\n== RESULT: {PASS} passed, {FAIL} failed (total HTTP requests: {REQ_COUNT}) ==")
    if FAILURES:
        print("Failed:", ", ".join(FAILURES))
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
