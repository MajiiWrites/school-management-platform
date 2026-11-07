import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { DEVELOPER } from '../config/developer';
import DeveloperFooter from '../components/DeveloperFooter';

/**
 * Public homepage at `/` — the front door for logged-out visitors.
 *
 * Sections, in order: navbar → hero → features → how it works →
 * developer details (LAST) → DeveloperFooter.
 *
 * Logged-in visitors never see this page: they are sent straight to
 * `/dashboard` (the portal index route moved there, so `/` is free for
 * this public page). All developer details come from
 * src/config/developer.ts — nothing here is hardcoded or invented.
 *
 * Colours are the app palette only (brand greens, amber accent, slate
 * neutrals on #f8fafc). Mobile-first: the navbar keeps the brand on the
 * left and both buttons on the right at 360 px — small text and padding
 * on the narrowest screens, larger from `sm` up.
 */

const FEATURES: { icon: string; title: string; body: string }[] = [
  {
    icon: '▦',
    title: 'Attendance',
    body: 'Mark who is present or absent each day, class by class — no more paper registers.',
  },
  {
    icon: '📷',
    title: 'Photo OCR student lists',
    body: 'Upload a photo of a handwritten student list and the app reads the names — in English and Urdu — so you do not type them one by one.',
  },
  {
    icon: '₨',
    title: 'Fees & reminders',
    body: 'Set the monthly fee once. Fee records are made automatically, and parents get a reminder before the due date.',
  },
  {
    icon: '✉',
    title: 'Absent SMS alerts',
    body: 'When a student is absent, a message to the parent is prepared automatically. Nothing is sent until you approve it.',
  },
  {
    icon: '🏆',
    title: 'Results & exams',
    body: 'Upload a photo of a result sheet or type marks in by hand. Toppers and report cards are made for you.',
  },
  {
    icon: '🕘',
    title: 'Timetable',
    body: 'Plan the weekly timetable for every class and see the whole week at a glance.',
  },
  {
    icon: '👩‍🏫',
    title: 'Payroll',
    body: 'Keep staff salaries and payments in one place, month by month.',
  },
  {
    icon: '🎓',
    title: 'Certificates & ID cards',
    body: 'Print certificates and student ID cards straight from the app.',
  },
];

const STEPS: { title: string; body: string }[] = [
  {
    title: 'Create your school account',
    body: 'Sign up with your school name and email. It takes about a minute.',
  },
  {
    title: 'Add your classes and students',
    body: 'Add classes, then add students by hand — or upload a list. A photo of a handwritten list works too.',
  },
  {
    title: 'Run the school day',
    body: 'Take attendance, collect fees and message parents — all from the dashboard.',
  },
];

export default function HomePage() {
  const { user } = useAuth();
  // Logged-in visitors belong on the dashboard, not the landing page.
  // No loading gate here on purpose: a logged-out visitor must see the
  // page at once, and a cached user is already in state on first paint.
  if (user) return <Navigate to="/dashboard" replace />;

  const d = DEVELOPER;

  return (
    <div className="min-h-screen bg-[#f8fafc] text-slate-900">
      {/* Navbar — brand big on the left, Login + Sign Up on the right. */}
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-1.5 px-4 py-3 sm:gap-2 sm:px-6">
          <Link to="/" className="shrink-0 whitespace-nowrap text-lg font-extrabold text-brand-900 sm:text-2xl">
            🏫 School Manager
          </Link>
          <nav className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2" aria-label="Account">
            <Link
              to="/login"
              className="whitespace-nowrap rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-[13px] font-medium text-slate-700 hover:bg-slate-50 sm:px-4 sm:text-sm"
            >
              Log in
            </Link>
            <Link
              to="/signup"
              className="whitespace-nowrap rounded-lg bg-brand-700 px-2.5 py-2 text-[13px] font-medium text-white hover:bg-brand-900 sm:px-4 sm:text-sm"
            >
              Sign Up
            </Link>
          </nav>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="bg-brand-50">
          <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
            <h1 className="max-w-2xl text-3xl font-extrabold leading-tight text-brand-900 sm:text-5xl">
              Run your whole school from one place.
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-relaxed text-slate-600 sm:text-lg">
              School Manager keeps attendance, fees, parent messages, results and timetables together — so a
              school can run on one simple app, without paper registers.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                to="/signup"
                className="rounded-lg bg-brand-700 px-5 py-3 text-sm font-medium text-white hover:bg-brand-900 sm:text-base"
              >
                Create your school account
              </Link>
              <Link
                to="/login"
                className="rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50 sm:text-base"
              >
                Log in
              </Link>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
          <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">Everything a school needs, in one place</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600 sm:text-base">
            Built for small schools: every daily job lives in the same app, so nothing is lost between notebooks,
            phones and paper.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <article key={f.title} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-2xl" aria-hidden="true">
                  {f.icon}
                </p>
                <h3 className="mt-3 text-base font-semibold text-slate-900">{f.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* How it works — 3 steps */}
        <section className="border-y border-slate-200 bg-white">
          <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
            <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">How it works</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600 sm:text-base">
              Three steps, and your school is running on it.
            </p>
            <ol className="mt-8 grid gap-4 sm:grid-cols-3">
              {STEPS.map((s, i) => (
                <li key={s.title} className="rounded-xl border border-slate-200 bg-[#f8fafc] p-5">
                  <p className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-700 text-base font-bold text-white">
                    {i + 1}
                  </p>
                  <h3 className="mt-3 text-base font-semibold text-slate-900">{s.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-slate-600">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Developer details — LAST section. Every value comes from DEVELOPER. */}
        <section className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6" aria-labelledby="developer-heading">
          <div className="rounded-xl border border-slate-200 bg-white px-5 py-10 text-center shadow-sm sm:px-8">
            <h2
              id="developer-heading"
              className="text-xs font-semibold uppercase tracking-widest text-slate-400"
            >
              About the Developer
            </h2>
            <img
              src={d.photo}
              alt={`Photo of ${d.name}`}
              className="mx-auto mt-6 h-40 w-40 rounded-full border-4 border-brand-100 object-cover ring-4 ring-brand-600/20 sm:h-48 sm:w-48"
            />
            <p className="mt-6 text-3xl font-extrabold text-slate-900 sm:text-4xl">{d.name}</p>
            <p className="mx-auto mt-2 max-w-md text-base leading-relaxed text-slate-600">{d.tagline}</p>
            <p className="mt-4 text-base text-slate-600">
              <span className="font-medium text-slate-700">WhatsApp: </span>
              <a
                className="font-medium text-brand-700 hover:underline"
                href={d.whatsappUrl}
                target="_blank"
                rel="noreferrer"
              >
                {d.phone}
              </a>
            </p>
            <p className="mt-2 text-base text-slate-600">
              <span className="font-medium text-slate-700">Email: </span>
              <a className="font-medium text-brand-700 hover:underline" href={`mailto:${d.email}`}>
                {d.email}
              </a>
            </p>
            <p className="mt-6 text-sm italic text-slate-500">{d.builtByLine}</p>
          </div>
        </section>
      </main>

      {/* Footer — compact DeveloperFooter, below the details section. */}
      <DeveloperFooter variant="compact" />
    </div>
  );
}
