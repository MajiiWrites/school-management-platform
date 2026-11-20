# Competitor Gap Analysis — Student Manager (School Management Platform)

Research date: 2026-11-19. Read-only research; no code changed.
Our platform: "Student Manager", live at https://school-management-platform-majiicrafts.vercel.app
Repo: https://github.com/MajiiWrites/school-management-platform
Stack: Node 20 + TypeScript + Express + Prisma + PostgreSQL, React + Vite + Tailwind, Tesseract OCR (eng+urd), Render free + Vercel.
Constraint: PKR 0 — no paid APIs, subscriptions, gateways, or per-message/per-user fees. Free tiers only.

## 1. Our verified feature inventory (from docs/V2-PROGRAM.md, docs/FIX-PROGRAM-LOG.md, backend/src/modules, frontend/src/pages)

- Attendance: Present/Absent only (Late/Leave deliberately removed by user order), tokenized teacher links, teacher attendance, absent-SMS drafts held for admin approval, dedupe `absent:{student}:{date}`, auto-cancel of unapproved drafts if attendance is edited.
- Students: extended profile (admission no., Urdu names, parent phones AES-256-GCM encrypted), CSV/Excel import with preview, photo OCR intake (student lists incl. 3-column tables, result sheets, timetables), live debounced search (server-side, 1000+ students), class/section move, struck-off flag, parent opt-out.
- Fees: monthly + arrears + admission fee, sibling + scholarship discounts, vouchers/challans, receipts, partial payment, fee reminders, defaulters report, whole-month totals.
- Exams/Results: exam types exactly Monthly Test / Midterm / Annual (+ nameable), datesheet, grading scales, OCR result-sheet import with review table, dense-rank positions, report cards (PDF + HTML + XLSX export), toppers, publish → message drafts via approval.
- Timetable: class-wise + teacher-wise, from photo, clash detection (409), both views.
- Staff/Payroll: staff records + assignments, simple payroll (Paid/Partial/Unpaid + remaining), PDF salary slips.
- Certificates + ID cards: from saved records, leaving reasons (Completed 5th/Middle/10th/Other), printable PDF + history.
- Announcements + Events/Holidays calendar; Expenses + income-vs-expense; Reports (defaulters, strength, message history) with CSV/PDF/XLSX export.
- Messaging: custom messages, templates (CRUD), 8 one-tap variables, recipient picker (all / one class / selected / single), absent + fee-unpaid quick filters, live preview + SMS-part counter, approval before send, drafts, scheduling, full history + delivery status. SMS delivery via admin's own SIM through the Android companion app (School SMS, APK built 2026-11-08; real-phone delivery test still pending).
- Admin/security: roles + permissions (incl. Principal view-only), TOTP 2FA, login alerts, session timeout, per-field change history / audit log, approval queue, recycle bin (soft delete + restore), per-school SMS sender number, automatic nightly backup job, guided tour + help section, multi-tenant isolation.
- Registration: signup collects school name, admin name, admin number (encrypted), address, Tehsil, District, Province (7-option dropdown), category Private/Public/Semi-Government, org type School/College. Settings shows read-only registration details.
- Homepage + SEO basics (meta description, robots.txt, sitemap.xml); Google Search Console submission NOT done.

## 2. Competitor feature summaries

- **Fedena** (fedena.com; 40,000+ schools): 20 core modules + 100+ total — admissions, attendance, timetable, gradebook, report cards, HR (leave + payroll), finance (fees, expenses, online payments), library (catalog, circulation, fines, barcoding), transport, hostel, events/calendar, parent/student portals, online exams, assignments, internal messaging, custom forms/reports, branded mobile apps. Sources: apibit.com/product/fedena, getapp.com (Fedena Pro), trustlist.uk, play.google.com (FedenaConnect).
- **PowerSchool SIS** (powerschool.com): SIS system of record — enrollment, demographics, attendance (daily/period/hybrid, auto absence notifications), gradebook (PowerTeacher Pro), master scheduler, report cards/transcripts, discipline, parent/student portal + mobile app (real-time notifications), online fee payment, state compliance reporting, OneRoster/Clever integrations. Sources: go.powerschool.com SIS flyers, seattleschools.org, pembinahills.ca, rilna.net.
- **Classter** (classter.com): SIS + LMS + SMS + ERP + CRM in 12 modules — Core, Admissions, Billing & Payments, Academics & LMS, Library, Transportation, CRM (parents/alumni engagement). Sources: classter.com, Slashdot comparisons.
- **Alma** (getalma.com): SIS + LMS — attendance (positive/negative, truancy reports, seating charts), gradebook (traditional/standards-based/competency), report cards, parent/student/teacher/admin portals, Google Classroom sync, discipline, admissions, fees/invoicing, analytics. Sources: getapp.com, softwareconnect.com, getalma.com, gettingsmart.com.
- **Gradelink** (gradelink.com): attendance, report cards, classes/scheduling, standards grading, lesson plans, grade sheets, parent communication (Smart Send: email/text/voice), student/parent access, custom reports. Sources: Slashdot, sourceforge.net, getapp.ca comparisons.
- **QuickSchools** (quickschools.com): admissions → graduation, attendance, report cards, gradebook, scheduling (Orchestra master scheduler), fee tracking, homework, LMS, parent/student portal, cafeteria, online payments, mobile app. Sources: Slashdot, sourceforge.net.
- **MyClassCampus** (myclasscampus.com, India): wireless biometric attendance, GPS bus tracking, bulk SMS, online payment gateway, finance, inquiry/admission, library, inventory, HR, timetable, hostel, fees, complaint mgmt, canteen, gate pass, wallet, results, transport, LMS (online classes, live assignments, exams), mobile apps. Sources: softwaresuggest.com, bestsoftware.co.in, pathsala.org/compare.
- **Vidyalaya** (India): ERP + mobile app — interactive dashboards for parents/teachers, digital report cards, online fee payments, communication. Source: teachmate360.com.
- **Campus 365** (campus-365.com, India): 18 modules — admissions, attendance, fees, exams, accounting, timetable, transport (routes/stops/live bus tracking), hostel, reports, online tests (question banks, auto-graded quizzes), homework, student/parent/teacher portals, live classes. Sources: campus-365.com, play.google.com.
- **SchoolTime** (India): mobile-first ERP — admission mgmt, fee payments, live classes, exam schedules, academic calendars, real-time communication. Source: teachmate360.com.
- **Blackbaud** (blackbaud.com, K-12 private/independent): SIS + LMS + enrollment mgmt + tuition/financial aid + accounting + fundraising + alumni engagement. Sources: tutorbase.com, edugist.org, saburati.com.
- **iSAMS** (isams.com, 1,800+ independent/international schools): modular MIS — central student records, admissions, attendance, timetabling, exams/reporting, finance, HR, wellbeing/safeguarding, portals + apps, multi-curriculum, multi-currency. Sources: tutorbase.com, saburati.com, softwareworld.co.
- **EduSuite** (edusuite.pk, Pakistan): 20+ modules — admissions (inquiry → test/interview → enroll), fees + JazzCash/EasyPaisa/SadaPay/HBL/QuickPay online collection, FBR-compliant invoicing, transport GPS, library, hostel, payroll/HR, LMS, inventory, AI syllabus/timetable/lesson planning (Punjab/FBISE-aligned), WhatsApp + SMS alerts, homework diaries, multi-campus, parent/staff mobile apps, free plan to 50 students. Sources: edusuite.pk, edflo.io comparison.
- **Schooliee** (schooliee.com, Pakistan): CNIC-linked family ledger across siblings, 1Bill payments (Easypaisa/JazzCash/all 1LINK bank apps), counter cash + 3-copy bank challans, WhatsApp alerts from school's own number (Rs 0 gateway fee) via paired desktop app, homework diaries, bilingual EN/UR circulars, double-entry accounting, register migration. Source: schooliee.com 2026 buyer's guide.
- **eSkooly** (eskooly.com, Pakistan, est. 2016): free-for-life Basic — admissions, attendance, timetable, exams + report cards, email/SMS notifications, basic reporting; Pro adds online fee collection, auto-grading, parent-teacher portal, branded Android app, library; top tiers add transport GPS, biometric/RFID, multi-branch, hostel/meal plans. Source: slashdot.org comparison (VigoCamp vs eSkooly).
- **eSchool / PakEducate / Edflo** (Pakistan): eSchool — longest track record, widest payment integrations (JazzCash/EasyPaisa/SadaPay/HBL/QuickPay), FBR invoicing, AI syllabus/timetable (Punjab/FBISE); PakEducate — cheapest entry (PKR 1,500/mo to 75 students), Urdu-first UI, parent QR access, AI-assisted admin; Edflo — 1BILL auto-reconciliation, multi-branch dashboard, flat PKR 2,999/mo to 150 students. Sources: pakeducate.com, edflo.io.

## 3. Comparison table (✓ have / ◐ partial / ✗ missing)

| Feature | Student Manager | Fedena | PowerSchool | Classter | Alma | Gradelink / QuickSchools | MyClassCampus / Campus 365 | EduSuite / Schooliee (PK) |
|---|---|---|---|---|---|---|---|---|
| Attendance (manual + teacher links) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (+biometric) | ✓ (+biometric) |
| Student records / profiles | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Fees + reminders + defaulters | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Exams, grading, report cards, toppers | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Timetable (incl. from photo) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Staff + payroll + payslips | ✓ | ✓ | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ |
| Certificates + ID cards | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Announcements / events / calendar | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Expenses + reports + exports | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Custom SMS + templates + approval | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Roles, 2FA, audit, recycle bin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Parent portal (login / read-only) | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Online admissions pipeline | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Homework / assignments | ✗ | ✓ | ✓ | ✓ (LMS) | ✓ | ✓ | ✓ | ✓ |
| Library (catalog, issue/return, fines) | ✗ | ✓ | ✗ | ✓ | ✗ | ◐ | ✓ | ✓ |
| Transport (routes/stops/assign) | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ (+GPS) | ✓ (+GPS) |
| Hostel / boarding | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| LMS / online classes / video | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Online fee payment (gateway) | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (JazzCash etc.) |
| Parent WhatsApp alerts | ◐ (SMS only) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Online exams / auto-graded quizzes | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ |
| Lesson planning / syllabus | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (AI) |
| Behaviour / discipline log | ✗ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ |
| College: semester / dept / CGPA | ◐ (org-type flag only) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Staff leave management | ✗ (deliberately removed) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Multi-campus / branches | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Double-entry accounting | ◐ (expenses only) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Visitor / gate-pass mgmt | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ |
| Photo OCR intake (lists/results/timetable, EN+UR) | ✓ (unique) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Free admin-SIM SMS (no gateway fee) | ✓ (unique) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ◐ (WhatsApp) |
| Guided tour + help section | ✓ | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ |

## 4. Ranked gaps (top 8) — see final report for full build specs

1. Parent portal (tokenized read-only link) — Medium
2. Online admissions pipeline — Medium
3. Homework diary / assignments — Small/Medium
4. Library management — Small/Medium
5. Transport management (routes/stops/assignment; NO GPS) — Medium
6. College mode (semester + departments + credit hours + CGPA) — Large
7. Online exams / auto-graded quizzes — Medium/Large
8. Behaviour / discipline log — Small

Honourable mentions: visitor/gate-pass (Small), payment-proof submission with challan reference (Small), double-entry accounting (Medium).

## 5. Deliberately NOT copy

1. Live GPS bus tracking + biometric / face-recognition attendance — paid hardware, GPS devices, biometric machines, per-device cost; also child-location privacy risk. (Transport without GPS is the free alternative.)
2. Built-in live video classes / full LMS with Zoom/Meet — paid video infra and heavy self-hosting; a teacher can already paste a Meet link into an announcement.
3. Online fee collection via JazzCash / EasyPaisa / 1Bill / Stripe — needs merchant accounts, commercial agreements, per-transaction fees, FBR invoicing; breaks PKR 0. Cash + printed challan + manual verification remains the model.
4. Branded white-label mobile apps per school (Fedena-style) — needs a Play Store developer account ($25), a build pipeline per school, and store review; our one companion app + responsive web covers the need for free.

## 6. Sources

- https://apibit.com/product/fedena/
- https://www.getapp.com/education-childcare-software/a/fedena-pro/
- https://trustlist.uk/school-accounting-software/fedena-pro
- https://play.google.com/store/apps/details?id=com.fedena.fconnect&hl=en_US
- https://go.powerschool.com/rs/861-RMI-846/images/PowerSchool%20SISs%20Overview%20Flyer%2011-7-18.pdf
- https://www.seattleschools.org/departments/dots/software-information/powerschool-product/
- https://www.pembinahills.ca/schools-programs/parents-information/powerschool-for-parents/
- https://www.rilna.net/software/powerschool-sis
- https://www.powerschool.com/solutions/communication/powerschool-mobile/
- https://www.classter.com/book-a-demo-with-classter-the-ultimate-hub-for-educational-management/
- https://www.getapp.com/education-childcare-software/a/alma/
- https://softwareconnect.com/reviews/alma-sis/
- https://www.getalma.com/independent-and-charter/
- https://Slashdot.org/software/comparison/Gradelink-SIS-vs-QuickSchools.com/
- https://sourceforge.net/software/compare/Gradelink-SIS-vs-QuickSchools.com/
- https://www.softwaresuggest.com/blog/myclasscampus-review/
- https://campus-365.com/
- https://www.bestsoftware.co.in/productDetails/myclasscampus/
- https://www.Teachmate360.com/Blogs/MobileAppBlog
- https://www.pathsala.org/compare
- https://tutorbase.com/blog/best-school-management-software
- https://saburati.com/en/blog/school-management-systems-compared-2026
- https://www.softwareworld.co/software/isams-reviews/
- https://www.edusuite.pk/school-erp/
- https://www.edusuite.pk/module/campus-management-system/
- https://www.edflo.io/blog/edflo-vs-edusuite
- https://www.schooliee.com/blogs/best-school-management-system-in-pakistan-2026-buyers-guide-comparison/
- https://www.edusuite.pk/blog/school-management-software-providers/
- https://pakeducate.com/blog/best-school-management-systems-pakistan-2026/
- https://www.edflo.io/blog/best-school-management-software-pakistan
- https://slashdot.org/software/comparison/VigoCamp-vs-eSkooly/
