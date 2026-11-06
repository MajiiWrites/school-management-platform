#!/usr/bin/env python3
"""6B live smoke test (scratch DB school_6b_smoke ONLY — never the live DB).
Drives the real server on :4126 through the public HTTP API:
signup/login, classes (per-section teachers + links), students (extended
profile, admission_no, move), CSV import preview + import, results manual
save, toppers/summary, report card, export, OCR sheet upload (real
Tesseract), review + confirm, publish-SMS drafts, soft delete + recycle
bin restore, clerk approval-queue flow, cross-tenant 404s.
Usage: python3 smoke-6b.py  (server must already be running on :4126)
"""
import io
import json
import sys
import urllib.request
import urllib.error

BASE = "http://localhost:4126/api/v1"

PASS = 0
FAIL = 0
FAILURES = []


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        FAILURES.append(name)
        print(f"  FAIL {name} {extra}")


def req(method, path, token=None, body=None, raw_headers=None):
    url = BASE + path
    data = None
    headers = {"Content-Type": "application/json"}
    if raw_headers:
        headers.update(raw_headers)
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
    boundary = "----smoke6bboundary"
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


def main():
    print("== 6B live smoke (scratch DB) ==")
    # --- School A signup + login ---
    s, r = req("POST", "/auth/signup", body={"school_name": "Smoke School", "email": "smoke-a@school.pk", "password": "Password123"})
    check("signup school A", s in (200, 201), str(r)[:200])
    s, r = req("POST", "/auth/login", body={"email": "smoke-a@school.pk", "password": "Password123"})
    check("login school A", s == 200 and "access" in r.get("data", {}), str(r)[:200])
    token_a = r["data"]["access"]
    admin_a = r["data"]["user"]["id"]

    # --- Classes: 5-A and 5-B, own teachers + own links ---
    s, r = req("POST", "/classes", token_a, {"name": "5", "section": "A", "teacher_name": "Ms. Shazia", "teacher_phone": "03001234567"})
    check("create class 5-A", s == 201, str(r)[:200])
    class_a = r["data"]["id"]
    s, r = req("POST", "/classes", token_a, {"name": "5", "section": "B", "teacher_name": "Mr. Bilal", "teacher_phone": "03007654321"})
    check("create class 5-B", s == 201, str(r)[:200])
    class_b = r["data"]["id"]
    s, r = req("POST", f"/classes/{class_a}/attendance-link/regenerate", token_a, {})
    check("regenerate link 5-A", s == 200 and "link" in r.get("data", {}), str(r)[:200])
    link_a = r["data"]["link"]
    s, r = req("POST", f"/classes/{class_b}/attendance-link/regenerate", token_a, {})
    check("regenerate link 5-B", s == 200 and r["data"]["link"] != link_a, str(r)[:200])
    # teacher change on 5-A only
    s, r = req("PATCH", f"/classes/{class_a}", token_a, {"teacher_name": "Ms. Ayesha"})
    check("change teacher 5-A", s == 200 and r["data"]["teacher_name"] == "Ms. Ayesha", str(r)[:200])
    s, r = req("GET", f"/classes/{class_b}", token_a)
    check("5-B teacher untouched", s == 200 and r["data"]["teacher_name"] == "Mr. Bilal", str(r)[:200])

    # --- Students: extended profile + admission_no uniqueness ---
    s, r = req("POST", f"/classes/{class_a}/students", token_a, {
        "name": "Ahmed Raza", "roll_no": 1, "parent_name": "Muhammad Raza",
        "parent_phone": "03001112222", "father_name": "Muhammad Raza",
        "admission_no": "ADM-001", "date_of_birth": "2018-05-01", "gender": "male",
        "address": "Street 1", "admission_date": "2026-04-01",
        "parent2_name": "Fatima Raza", "parent2_phone": "03003334444",
    })
    check("create student (extended profile)", s == 201 and r["data"]["admission_no"] == "ADM-001", str(r)[:300])
    stu1 = r["data"]["id"]
    s, r = req("POST", f"/classes/{class_a}/students", token_a, {"name": "Copy Cat", "admission_no": "ADM-001"})
    check("duplicate admission_no -> 409", s == 409, str(r)[:200])
    s, r = req("POST", f"/classes/{class_a}/students", token_a, {"name": "Fatima Khan", "roll_no": 2, "parent_phone": "03005556666", "admission_no": "ADM-002"})
    check("create student 2", s == 201, str(r)[:200])
    stu2 = r["data"]["id"]
    s, r = req("POST", f"/classes/{class_a}/students", token_a, {"name": "Bilal Ahmed", "roll_no": 3, "parent_phone": "03007778888", "admission_no": "ADM-003"})
    check("create student 3", s == 201, str(r)[:200])
    stu3 = r["data"]["id"]

    # status change incl. struck_off
    s, r = req("PATCH", f"/students/{stu3}", token_a, {"status": "struck_off"})
    check("status -> struck_off", s == 200 and r["data"]["status"] == "struck_off", str(r)[:200])
    s, r = req("PATCH", f"/students/{stu3}", token_a, {"status": "active"})
    check("status -> active again", s == 200, str(r)[:200])

    # school-wide search by admission_no
    s, r = req("GET", "/students?admission_no=ADM-001", token_a)
    check("GET /students?admission_no=", s == 200 and r["data"]["total"] == 1, str(r)[:200])

    # move stu2 5-A -> 5-B
    s, r = req("POST", f"/students/{stu2}/move", token_a, {"class_id": class_b})
    check("move student to 5-B", s == 200 and r["data"]["class_id"] == class_b, str(r)[:200])
    s, r = req("GET", f"/classes/{class_b}/students", token_a)
    check("5-B lists moved student", s == 200 and any(x["id"] == stu2 for x in r["data"]["items"]), str(r)[:200])

    # --- CSV import preview + import ---
    csv = (
        "name,roll_no,father_name,admission_no,parent_phone\n"
        "Sara Ahmed,4,Ali Khan,ADM-004,03009990000\n"
        "Ahmed Raza,5,,,03001112222\n"
        "Bad Phone,6,,,12345\n"
    ).encode()
    s, r = multipart(f"/classes/{class_a}/students/import-preview", token_a, {}, "file", "import.csv", csv, "text/csv")
    check("import preview", s == 200 and r["data"]["valid"] == 1 and r["data"]["duplicates_flagged"] == 1, str(r)[:300])
    s, r = multipart(f"/classes/{class_a}/students/import-csv", token_a, {}, "file", "import.csv", csv, "text/csv")
    check("import csv (only valid row)", s == 200 and r["data"]["imported"] == 1, str(r)[:300])

    # --- Results: manual entry (creates Midterm exam) ---
    s, r = req("POST", "/results/manual", token_a, {
        "exam_name": "Midterm", "class_id": class_a,
        "rows": [
            {"roll_no": 1, "student_name": "Ahmed Raza", "subject_marks": {"English": 85, "Math": 90}, "obtained_marks": 175, "total_marks": 200},
            {"roll_no": 3, "student_name": "Bilal Ahmed", "subject_marks": {"English": 40, "Math": 30}, "obtained_marks": 70, "total_marks": 200},
        ],
    })
    check("manual results save", s == 200 and r["data"]["saved"] == 2 and r["data"]["linked"] == 2, str(r)[:300])
    s, r = req("GET", "/exams", token_a)
    check("Midterm exam exists", s == 200 and any(e["name"] == "Midterm" for e in r["data"]["items"]), str(r)[:300])
    exam_id = next(e["id"] for e in r["data"]["items"] if e["name"] == "Midterm")

    s, r = req("GET", f"/results?exam_id={exam_id}&class_id={class_a}", token_a)
    check("list results", s == 200 and r["data"]["total"] == 2, str(r)[:200])
    res1 = next(x for x in r["data"]["items"] if x["roll_no"] == 1)
    check("Ahmed linked + position 1", res1["linked"] and res1["position"] == 1 and res1["percentage"] == 87.5, str(res1)[:200])
    s, r = req("GET", f"/results/toppers?exam_id={exam_id}&class_id={class_a}", token_a)
    check("toppers", s == 200 and r["data"]["items"][0]["student_name"] == "Ahmed Raza", str(r)[:200])
    s, r = req("GET", f"/results/summary?exam_id={exam_id}&class_id={class_a}", token_a)
    check("summary (33% default)", s == 200 and r["data"]["passed"] == 2 and r["data"]["passing_threshold_percent"] == 33, str(r)[:300])

    # PATCH recompute
    s, r = req("PATCH", f"/results/{res1['id']}", token_a, {"obtained_marks": 190})
    check("PATCH result recomputes %", s == 200 and r["data"]["percentage"] == 95.0, str(r)[:200])

    # report card html + pdf + export
    s, r = req("GET", f"/results/report-card/{stu1}/{exam_id}", token_a)
    check("report card HTML", s == 200 and b"Ahmed Raza" in (r if isinstance(r, bytes) else b""), str(r)[:100])
    s, r = req("GET", f"/results/export?format=xlsx&exam_id={exam_id}&class_id={class_a}", token_a)
    check("export xlsx", s == 200 and isinstance(r, bytes) and len(r) > 500, f"status={s}")

    # --- OCR sheet upload (real Tesseract) ---
    png = make_sheet_png()
    s, r = multipart(f"/classes/{class_a}/results/upload", token_a, {"exam_name": "Final"}, "image", "sheet.png", png, "image/png")
    check("OCR upload sheet", s == 201 and len(r.get("data", {}).get("rows", [])) >= 2, str(r)[:400])
    if s == 201:
        sheet_id = r["data"]["result_sheet_id"]
        exam_final = r["data"]["exam_id"]
        s, r = req("GET", f"/results/review/{sheet_id}", token_a)
        check("review sheet + link preview", s == 200 and len(r["data"]["rows"]) >= 2, str(r)[:300])
        rows = [
            {"roll_no": row["roll_no"], "student_name": row["student_name"],
             "subject_marks": row.get("subject_marks") or {},
             "obtained_marks": row.get("obtained_marks"), "total_marks": row.get("total_marks")}
            for row in r["data"]["rows"] if row.get("roll_no")
        ]
        s, r = req("POST", f"/result-sheets/{sheet_id}/confirm", token_a, {"rows": rows})
        check("confirm sheet rows", s == 200 and r["data"]["saved"] >= 2, str(r)[:300])
        s, r = req("POST", f"/result-sheets/{sheet_id}/publish", token_a, {})
        check("publish -> SMS drafts", s == 200 and r["data"]["drafts_created"] >= 1, str(r)[:300])
        s, r = req("GET", "/messages/drafts?status=draft", token_a)
        check("drafts visible in messages", s == 200 and r["data"]["total"] >= 1, str(r)[:200])
    else:
        print("  (OCR upload failed — skipping review/confirm/publish checks)")

    # --- Soft delete + recycle bin restore (result) ---
    s, r = req("GET", f"/results?exam_id={exam_id}&class_id={class_a}", token_a)
    target = r["data"]["items"][0]
    s, r = req("DELETE", f"/results/{target['id']}", token_a)
    check("soft-delete result", s == 200, str(r)[:200])
    s, r = req("GET", f"/results/{target['id']}", token_a)
    check("deleted result -> 404", s == 404, str(r)[:200])
    s, r = req("GET", "/recycle-bin?entity=result", token_a)
    check("recycle bin lists result", s == 200 and r["data"]["total"] >= 1, str(r)[:200])
    bin_id = r["data"]["items"][0]["id"]
    s, r = req("POST", f"/recycle-bin/{bin_id}/restore", token_a, {})
    check("restore result", s == 200, str(r)[:200])
    s, r = req("GET", f"/results/{target['id']}", token_a)
    check("restored result readable", s == 200, str(r)[:200])

    # --- Clerk approval queue ---
    s, r = req("POST", "/users/clerks", token_a, {"email": "clerk@school.pk", "password": "Password123"})
    check("create clerk", s in (200, 201), str(r)[:200])
    s, r = req("POST", "/auth/login", body={"email": "clerk@school.pk", "password": "Password123"})
    check("clerk login", s == 200, str(r)[:200])
    token_c = r["data"]["access"]
    s, r = req("POST", "/results/manual", token_c, {
        "exam_name": "Monthly Test", "class_id": class_a,
        "rows": [{"roll_no": 1, "student_name": "Ahmed Raza", "obtained_marks": 88, "total_marks": 100}],
    })
    check("clerk manual save -> 202 queued", s == 202 and r["data"]["status"] == "pending", str(r)[:300])
    appr_id = r["data"]["approval_request_id"]
    s, r = req("GET", "/results?class_id=" + class_a, token_a)
    monthly_before = [x for x in r["data"]["items"] if x.get("exam_id")]
    s, r = req("POST", f"/approvals/{appr_id}/approve", token_a, {})
    check("admin approves clerk result", s == 200, str(r)[:300])
    s, r = req("GET", "/exams", token_a)
    check("Monthly Test exam now exists", s == 200 and any(e["name"] == "Monthly Test" for e in r["data"]["items"]), str(r)[:200])

    # --- Cross-tenant: school B ---
    s, r = req("POST", "/auth/signup", body={"school_name": "Other School", "email": "smoke-b@school.pk", "password": "Password123"})
    check("signup school B", s in (200, 201), str(r)[:200])
    s, r = req("POST", "/auth/login", body={"email": "smoke-b@school.pk", "password": "Password123"})
    token_b = r["data"]["access"]
    s, r = req("GET", f"/results/{target['id']}", token_b)
    check("B cannot read A's result -> 404", s == 404, str(r)[:200])
    s, r = req("GET", f"/results?exam_id={exam_id}&class_id={class_a}", token_b)
    check("B list of A exam is empty", s == 200 and r["data"]["total"] == 0, str(r)[:200])
    s, r = req("GET", f"/classes/{class_a}/students", token_b)
    check("B cannot list A's students -> 404", s == 404, str(r)[:200])
    s, r = req("POST", f"/students/{stu1}/move", token_b, {"class_id": class_b})
    check("B cannot move A's student", s in (403, 404), str(r)[:200])

    print(f"\n== RESULT: {PASS} passed, {FAIL} failed ==")
    if FAILURES:
        print("Failed:", ", ".join(FAILURES))
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
