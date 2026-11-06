import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Button, Modal } from './ui';

/**
 * P8-TOUR: guided tour + help relaunch (Phase 10 criterion E).
 *
 * Modal-based on purpose — NO tour library, NO element highlighting, NO
 * DOM queries. Each step navigates to the real page it talks about, so the
 * admin sees the actual screen behind the modal. If a route ever goes
 * missing, the modal still works and the tour never blocks the page.
 *
 * - Auto-opens once, on first login, for an admin who has never seen it.
 *   "Seen" is stored per user in localStorage (`smp_tour_seen_<userId>`).
 *   Finishing OR skipping marks it seen; it never nags again.
 * - Relaunch anytime: any component can call `startGuidedTour()` (the
 *   header "?" button and the Help page both do).
 * - Mobile-safe: reuses the shared Modal (bottom sheet on small screens).
 * - 8 steps max, plain wording, no jargon.
 */
export const TOUR_START_EVENT = 'smp:start-tour';

/** Relaunch the tour from anywhere (header button, Help page). */
export function startGuidedTour() {
  window.dispatchEvent(new CustomEvent(TOUR_START_EVENT));
}

const tourSeenKey = (userId: string) => `smp_tour_seen_${userId}`;

interface TourStep {
  /** Route shown behind this step. */
  to: string;
  title: string;
  body: string;
}

const TOUR_STEPS: TourStep[] = [
  {
    to: '/',
    title: 'Welcome — this is your home page',
    body: 'The boxes show today at a glance: how many classes sent attendance, how many students are present or absent, and how much fee money came in this month versus how much is still pending. A red or amber number needs your attention.',
  },
  {
    to: '/classes',
    title: 'Classes and sections',
    body: 'A class is one group of students, like Class 5. A section is a part of a class, like 5-A and 5-B. Each section has its own teacher and its own attendance link. Add your first class here.',
  },
  {
    to: '/students',
    title: 'Students',
    body: 'Students belong to a class and section. You can add one student at a time, or upload many at once from a CSV or Excel file. Every student has a roll number (their number in the class) and an admission number (their number in the school).',
  },
  {
    to: '/classes',
    title: 'Attendance links — for teachers',
    body: 'Every class has a special link. Share it with the teacher, for example on WhatsApp. The teacher opens it on their phone, marks who is present or absent, and submits. You do not need to be there.',
  },
  {
    to: '/messages',
    title: 'Messages — nothing sends without you',
    body: 'When a student is absent, a message is prepared for the parent — but nothing is sent until you approve it here. Read it, then approve. Parents who asked not to receive messages are skipped automatically.',
  },
  {
    to: '/fees',
    title: 'Fees',
    body: 'Set the monthly fee for each class once. Every month, a fee record is made for each student automatically. Tap "Mark paid" when a parent pays. A voucher (challan) is a printed bill you can hand to the parent.',
  },
  {
    to: '/results',
    title: 'Results',
    body: 'Upload a photo of a result sheet and the app reads the marks, or type marks in by hand. Check every row before you confirm — red rows need a second look, and nothing is saved until you confirm. Toppers and report cards are made automatically.',
  },
  {
    to: '/settings',
    title: 'Settings and security',
    body: 'Your school name, holidays and session live in Settings. Security — also in the menu — is where you turn on two-step login (2FA) and see who signed in. Stuck anywhere? The Help page in the menu explains every common task in short steps.',
  },
];

export default function GuidedTour() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const autoOpened = useRef(false);

  const markSeen = useCallback(() => {
    if (!user) return;
    try {
      localStorage.setItem(tourSeenKey(user.id), '1');
    } catch {
      /* Private mode / storage blocked: the tour may show again once. Harmless. */
    }
  }, [user]);

  const close = useCallback(() => {
    markSeen();
    setOpen(false);
  }, [markSeen]);

  // First login: auto-open once for an admin who has never seen the tour.
  useEffect(() => {
    if (!user || autoOpened.current) return;
    autoOpened.current = true;
    let seen = false;
    try {
      seen = localStorage.getItem(tourSeenKey(user.id)) === '1';
    } catch {
      seen = false;
    }
    if (!seen) {
      setStep(0);
      setOpen(true);
    }
  }, [user]);

  // Relaunch from anywhere (header "?" button, Help page).
  useEffect(() => {
    const onStart = () => {
      setStep(0);
      setOpen(true);
    };
    window.addEventListener(TOUR_START_EVENT, onStart);
    return () => window.removeEventListener(TOUR_START_EVENT, onStart);
  }, []);

  // Each step shows its real page behind the modal.
  useEffect(() => {
    if (!open) return;
    const to = TOUR_STEPS[step].to;
    if (location.pathname !== to) navigate(to, { replace: true });
  }, [open, step, location.pathname, navigate]);

  if (!open) return null;

  const current = TOUR_STEPS[step];
  const isFirst = step === 0;
  const isLast = step === TOUR_STEPS.length - 1;

  return (
    <Modal title={`Guided tour — step ${step + 1} of ${TOUR_STEPS.length}`} onClose={close}>
      <p className="text-lg font-semibold text-slate-900">{current.title}</p>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{current.body}</p>
      <div className="mt-4 flex items-center gap-1.5" aria-label={`Step ${step + 1} of ${TOUR_STEPS.length}`}>
        {TOUR_STEPS.map((s, i) => (
          <span
            key={s.title}
            className={`h-1.5 flex-1 rounded-full ${i <= step ? 'bg-brand-700' : 'bg-slate-200'}`}
          />
        ))}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button variant="secondary" disabled={isFirst} onClick={() => setStep((s) => Math.max(0, s - 1))}>
          Back
        </Button>
        <Button onClick={() => (isLast ? close() : setStep((s) => Math.min(TOUR_STEPS.length - 1, s + 1)))}>
          {isLast ? 'Finish tour' : 'Next'}
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" onClick={close}>
          Skip tour
        </Button>
      </div>
    </Modal>
  );
}
