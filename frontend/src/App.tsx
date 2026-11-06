import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
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
              <Layout />
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
          <Route
            path="settings"
            element={
              <RequireAdmin>
                <SettingsPage />
              </RequireAdmin>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
