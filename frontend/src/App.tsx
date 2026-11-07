import { lazy } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import { Spinner } from './components/ui';
import { ForgotPasswordPage, LoginPage, ResetPasswordPage, SignupPage, VerifyEmailPage } from './pages/Auth';
import TeacherLinkPage from './pages/TeacherLink';
import HomePage from './pages/Home'; // public landing page at `/` (entry chunk — first paint for logged-out visitors)
import { LanguageProvider } from './lib/i18n';
// R2-E (round 2): route-level code splitting. The whole portal used to
// ship as one 596 kB JS chunk, so a cold first paint waited on all of it.
// Pages now load on demand; Layout wraps <Outlet /> in a Suspense
// fallback, so the sidebar stays visible while a page chunk loads.
// Auth pages + the public teacher link stay in the entry chunk — they
// are the first paint for logged-out / token users.
const DashboardPage = lazy(() => import('./pages/Dashboard'));
const ClassesPage = lazy(() => import('./pages/Classes'));
const ClassDetailPage = lazy(() =>
  import('./pages/Classes').then((m) => ({ default: m.ClassDetailPage })),
);
const StudentsPage = lazy(() => import('./pages/Students'));
const OcrReviewPage = lazy(() => import('./pages/OcrReview'));
const FeesPage = lazy(() => import('./pages/Fees'));
const MessagesPage = lazy(() => import('./pages/Messages'));
const ParentsPage = lazy(() => import('./pages/Parents'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const ReportsPage = lazy(() => import('./pages/Reports'));
// 6C-2 pages: expenses, announcements, events, certificates, notifications.
const ExpensesPage = lazy(() => import('./pages/Expenses'));
const AnnouncementsPage = lazy(() => import('./pages/Announcements'));
const EventsPage = lazy(() => import('./pages/Events'));
const CertificatesPage = lazy(() => import('./pages/Certificates'));
const NotificationsPage = lazy(() => import('./pages/Notifications'));
const SecurityPage = lazy(() => import('./pages/Security')); // 6D: 2FA, roles & permissions, data export, login alerts, backups
const ApprovalsPage = lazy(() => import('./pages/Approvals')); // D2: admin approval queue for clerk changes
const RecycleBinPage = lazy(() => import('./pages/RecycleBin')); // D1: admin recycle bin (30-day restore)
const ChangeHistoryPage = lazy(() => import('./pages/ChangeHistory')); // D1: admin change history (old → new)
const ResultsPage = lazy(() => import('./pages/Results')); // 6B: results (OCR sheets, toppers, report cards)
// 6C-1 pages: sessions / exams / timetable / staff & payroll.
const SessionsPage = lazy(() => import('./pages/Sessions'));
const ExamsPage = lazy(() => import('./pages/Exams'));
const TimetablePage = lazy(() => import('./pages/Timetable'));
const StaffPage = lazy(() => import('./pages/Staff'));
// P8-TOUR: guided tour + help page (Phase 10 criterion E).
const HelpPage = lazy(() => import('./pages/Help'));

/** Redirects to /login when there is no signed-in user. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  // R2-E (round 2) blank-white fix: a returning user already has a cached
  // user in localStorage, so render the app shell immediately instead of
  // blocking the whole tree on /auth/me (Render cold start can take
  // ~60 s — that wait used to show nothing but a spinner, and with the
  // old service-worker shell it showed a bare white page). /auth/me
  // still re-verifies in the background; a 401/403 signs out via
  // AuthContext. Only a genuinely unknown session (no cached user)
  // waits on the spinner.
  if (!user) {
    if (loading) {
      return (
        <div className="flex min-h-screen items-center justify-center">
          <Spinner label="Checking your session…" />
        </div>
      );
    }
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-16 text-center">
      <p className="text-lg font-semibold text-slate-800">Page not found</p>
      <p className="mt-1 text-sm text-slate-500">The link may be wrong, or the page was moved.</p>
      <a href="/dashboard" className="mt-4 inline-block font-medium text-brand-700 hover:underline">
        Go to the dashboard
      </a>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      {/* A single page's render error must never blank the whole app again. */}
      <ErrorBoundary>
        <Routes>
        {/* Public */}
        {/* Homepage: `/` shows the landing page to logged-out visitors;
            HomePage itself redirects signed-in users to /dashboard. The
            portal below is a pathless layout route with no index child, so
            it does not match `/` — this route wins unambiguously. */}
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/t/:token" element={<TeacherLinkPage />} />

        {/* R2-C fix (F3): dead routes — /calendar and /holidays.
            These used to live inside the authenticated portal below, so the
            redirect only fired after the auth gate, Layout and all its
            mount-time effects had run — and the GuidedTour's auto-open used
            to drag a fresh admin to '/' before the target ever rendered, so
            on live (fresh TEST school, first login) the redirects looked
            dead. As top-level routes the redirect fires on match, before
            any auth/layout work; an unauthenticated visit lands on /events
            and RequireAuth then sends it to /login as usual.
            The calendar lives on /events (it merges holidays), holidays are
            managed in Settings. Module G (2026-11-07): the removed page's
            old paths are gone too — they now fall through to NotFound. */}
        <Route path="/calendar" element={<Navigate to="/events" replace />} />
        <Route path="/holidays" element={<Navigate to="/events" replace />} />

        {/* Authenticated portal */}
        <Route
          element={
            <RequireAuth>
              <LanguageProvider>
                <Layout />
              </LanguageProvider>
            </RequireAuth>
          }
        >
          {/* Dashboard — lives at /dashboard now that `/` is the public homepage. */}
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="classes" element={<ClassesPage />} />
          <Route path="classes/:id" element={<ClassDetailPage />} />
          <Route path="classes/:id/ocr" element={<OcrReviewPage />} />
          <Route path="students" element={<StudentsPage />} />
          <Route path="parents" element={<ParentsPage />} />
          <Route path="fees" element={<FeesPage />} />
          <Route path="messages" element={<MessagesPage />} />
          <Route path="reports" element={<ReportsPage />} />
          {/* 6C-2 routes */}
          <Route path="expenses" element={<ExpensesPage />} />
          <Route path="announcements" element={<AnnouncementsPage />} />
          <Route path="events" element={<EventsPage />} />
          <Route path="certificates" element={<CertificatesPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          {/* 6B: results */}
          <Route path="results" element={<ResultsPage />} />
          {/* 6C-1 routes */}
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="exams" element={<ExamsPage />} />
          <Route path="timetable" element={<TimetablePage />} />
          <Route path="staff" element={<StaffPage />} />
          {/* P8-TOUR: Help page (guided tour + how-tos + glossary). */}
          <Route path="help" element={<HelpPage />} />
          {/* Dead routes moved to top level (above the portal) — see above. */}
          {/* D2: Approval Queue page (admin only) */}
          <Route
            path="approvals"
            element={
              <RequireAdmin>
                <ApprovalsPage />
              </RequireAdmin>
            }
          />
          {/* D1: Recycle Bin + Change History pages (admin only) */}
          <Route
            path="recycle-bin"
            element={
              <RequireAdmin>
                <RecycleBinPage />
              </RequireAdmin>
            }
          />
          <Route
            path="change-history"
            element={
              <RequireAdmin>
                <ChangeHistoryPage />
              </RequireAdmin>
            }
          />
          <Route
            path="settings"
            element={
              <RequireAdmin>
                <SettingsPage />
              </RequireAdmin>
            }
          />
          {/* 6D: Security page (admin only) */}
          <Route
            path="security"
            element={
              <RequireAdmin>
                <SecurityPage />
              </RequireAdmin>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      </ErrorBoundary>
    </AuthProvider>
  );
}
