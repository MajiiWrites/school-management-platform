import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import { Spinner } from './components/ui';
import { ForgotPasswordPage, LoginPage, ResetPasswordPage, SignupPage, VerifyEmailPage } from './pages/Auth';
import DashboardPage from './pages/Dashboard';
import ClassesPage, { ClassDetailPage } from './pages/Classes';
import StudentsPage from './pages/Students';
import OcrReviewPage from './pages/OcrReview';
import TeacherLinkPage from './pages/TeacherLink';
import FeesPage from './pages/Fees';
import MessagesPage from './pages/Messages';
import ParentsPage from './pages/Parents';
import SettingsPage from './pages/Settings';
import ReportsPage from './pages/Reports';
// 6C-2 pages: expenses, announcements, events, certificates, leave/late, notifications.
import ExpensesPage from './pages/Expenses';
import AnnouncementsPage from './pages/Announcements';
import EventsPage from './pages/Events';
import CertificatesPage from './pages/Certificates';
import LeavesPage from './pages/Leaves';
import NotificationsPage from './pages/Notifications';
import { LanguageProvider } from './lib/i18n';
import SecurityPage from './pages/Security'; // 6D: 2FA, roles & permissions, data export, login alerts, backups
import ApprovalsPage from './pages/Approvals'; // D2: admin approval queue for clerk changes
import RecycleBinPage from './pages/RecycleBin'; // D1: admin recycle bin (30-day restore)
import ChangeHistoryPage from './pages/ChangeHistory'; // D1: admin change history (old → new)
import ResultsPage from './pages/Results'; // 6B: results (OCR sheets, toppers, report cards)
// 6C-1 pages: sessions / exams / timetable / staff & payroll.
import SessionsPage from './pages/Sessions';
import ExamsPage from './pages/Exams';
import TimetablePage from './pages/Timetable';
import StaffPage from './pages/Staff';
// P8-TOUR: guided tour + help page (Phase 10 criterion E).
import HelpPage from './pages/Help';

/** Redirects to /login when there is no signed-in user. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Checking your session…" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-16 text-center">
      <p className="text-lg font-semibold text-slate-800">Page not found</p>
      <p className="mt-1 text-sm text-slate-500">The link may be wrong, or the page was moved.</p>
      <a href="/" className="mt-4 inline-block font-medium text-brand-700 hover:underline">
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
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/t/:token" element={<TeacherLinkPage />} />

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
          <Route index element={<DashboardPage />} />
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
          <Route path="leaves" element={<LeavesPage />} />
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
          {/* Phase 9 fix: dead routes — /calendar, /holidays and /leave
              404'd (old bookmarks / in-page references). The calendar
              lives on /events (it merges holidays), holidays are managed
              in Settings, and leave applications live on /leaves. */}
          <Route path="calendar" element={<Navigate to="/events" replace />} />
          <Route path="holidays" element={<Navigate to="/events" replace />} />
          <Route path="leave" element={<Navigate to="/leaves" replace />} />
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
