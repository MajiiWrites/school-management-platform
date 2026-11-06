import { Button, Card } from '../components/ui';
import Tooltip from '../components/Tooltip';
import { startGuidedTour } from '../components/GuidedTour';
import { DEVELOPER } from '../config/developer';

/**
 * P8-TOUR: Help page (Phase 10 criterion E). Plain-language how-tos for
 * the common tasks (each 5 steps or fewer), a glossary of the words the
 * app uses, and the support contact from the project config
 * (`frontend/src/config/developer.ts` — no invented contacts).
 * Linked from the sidebar; reachable at /help for every signed-in role.
 */

const HOW_TOS: { title: string; steps: string[] }[] = [
  {
    title: 'Add a class',
    steps: [
      'Open Classes in the menu.',
      'Tap "New class" (or "Add your first class").',
      'Type the class name (for example 5), the section (for example A), and the teacher name and phone number.',
      'Check the details in the confirmation box, then confirm.',
      'The class appears in the list — now add its students.',
    ],
  },
  {
    title: 'Add a student',
    steps: [
      'Open Students in the menu and pick the class.',
      'Tap "Add student".',
      'Type the student name, roll number and parent phone number.',
      'Check the details in the confirmation box, then confirm.',
      'To add many students at once, use the CSV / Excel import on the same page instead.',
    ],
  },
  {
    title: 'Send attendance (teacher link)',
    steps: [
      'Open Classes and open the class.',
      'Copy the attendance link and share it with the teacher (for example on WhatsApp).',
      'The teacher opens the link on their phone, marks present / absent / late, and submits.',
      'Absent students appear in Messages under "Pending approval" — nothing is sent to parents until you approve it there.',
    ],
  },
  {
    title: 'Approve a message',
    steps: [
      'Open Messages in the menu.',
      'Open the "Pending approval" tab.',
      'Read the message and check who it goes to.',
      'Tap "Approve" — the message is queued and sent. Tap "Edit" first if something is wrong.',
    ],
  },
  {
    title: 'Collect a fee',
    steps: [
      'Open Fees in the menu and pick the month.',
      'Find the student and tap "Mark paid".',
      'Type the amount received (leave the discount empty if there is none).',
      'Check the details in the confirmation box, then confirm — a receipt number is shown.',
    ],
  },
  {
    title: 'Upload a result sheet',
    steps: [
      'Open Results in the menu and pick the class and exam.',
      'Upload a clear photo of the result sheet (or type marks in by hand).',
      'Check every row in the review table — red rows are low-confidence and need a second look.',
      'Tap "Confirm & save". Nothing is saved until you confirm.',
    ],
  },
  {
    title: 'Set up two-step login (2FA)',
    steps: [
      'Open Security in the menu (admin only).',
      'Open the two-factor (2FA) section and tap "Set up".',
      'Copy the secret into your authenticator app (Google Authenticator or similar).',
      'Type the 6-digit code from the app and verify.',
      'From now on, login asks for your password plus a code from the app.',
    ],
  },
];

const GLOSSARY: { word: string; meaning: string }[] = [
  { word: 'Section', meaning: 'A part of a class. Class 5 can have sections 5-A and 5-B — each has its own teacher and its own attendance link.' },
  { word: 'Roll number', meaning: 'The student’s number inside their class (1, 2, 3…). Two students in the same class never share a roll number.' },
  { word: 'Admission number', meaning: 'The student’s number in the whole school, given when they join. It never changes, even if the student moves to another class.' },
  { word: 'Voucher', meaning: 'A printed bill for one student for one month. It shows how much is due and the last date to pay. You can print it from the Fees page.' },
  { word: 'Challan', meaning: 'Another word for a voucher — the printed fee bill a parent takes to pay.' },
  { word: 'Dedupe', meaning: 'Short for "remove duplicates". Every message has a dedupe key, so the same message is never sent twice to the same parent, even if it is approved twice.' },
  { word: 'Arrears', meaning: 'Fee left unpaid from earlier months. It is added to the next month’s amount due, so a student who paid only part of last month still owes the rest.' },
  { word: 'Sibling discount', meaning: 'A reduction for families with two or more children in the school. It is entered as a discount when a fee is recorded.' },
  { word: 'Scheduled message', meaning: 'A message set to send at a date and time you pick. It still needs an admin’s approval first — an unapproved scheduled message never sends.' },
  { word: 'Recycle bin', meaning: 'When you delete something (a class, student, result or template), a copy is kept for 30 days so it can be restored. After 30 days it is gone for good.' },
];

export default function HelpPage() {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Help</h1>
          <p className="text-sm text-slate-500">Short steps for the things you will do most often. No jargon.</p>
        </div>
        <Button onClick={startGuidedTour}>Take the tour</Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {HOW_TOS.map((h) => (
          <Card key={h.title} className="p-5">
            <h2 className="text-base font-semibold text-slate-900">{h.title}</h2>
            <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-slate-700">
              {h.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </Card>
        ))}
      </div>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-slate-900">What do the words mean?</h2>
        <dl className="mt-3 space-y-3">
          {GLOSSARY.map((g) => (
            <div key={g.word} className="text-sm">
              <dt className="font-semibold text-slate-900">
                {g.word}
                <Tooltip text={g.meaning} label={`What does ${g.word} mean?`} />
              </dt>
              <dd className="mt-0.5 text-slate-600">{g.meaning}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-slate-900">Still stuck?</h2>
        <p className="mt-2 text-sm text-slate-600">
          Email support at{' '}
          <a className="font-medium text-brand-700 hover:underline" href={`mailto:${DEVELOPER.email}`}>
            {DEVELOPER.email}
          </a>
          . Please say which page you were on and what you were trying to do.
        </p>
      </Card>
    </div>
  );
}
