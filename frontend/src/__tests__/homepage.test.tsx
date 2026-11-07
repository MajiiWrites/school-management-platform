// Homepage regression tests: the public landing page at `/`.
//
// - Logged-out visitors see the page: navbar (brand left, Login + Sign Up
//   right), hero, features, how-it-works, developer details LAST, then the
//   compact DeveloperFooter — in that order, with none of the removed
//   role words anywhere in the rendered page.
// - Logged-in visitors are redirected to /dashboard instead.
// - Every developer value shown comes from src/config/developer.ts.
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authState } = vi.hoisted(() => ({
  authState: { user: null as unknown, loading: false },
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: authState.user,
    loading: authState.loading,
    login: vi.fn(),
    signup: vi.fn(),
    logout: vi.fn(),
    sessionExpired: false,
    clearSessionExpired: vi.fn(),
  }),
}));

import HomePage from '../pages/Home';
import { DEVELOPER } from '../config/developer';

const LOGGED_IN_USER = {
  id: 'u1',
  email: 'admin@school.pk',
  role: 'admin',
  school_name: 'Test School',
  email_verified: true,
};

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/dashboard" element={<div>Dashboard stub</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  authState.user = null;
  authState.loading = false;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('homepage (logged out)', () => {
  it('renders the sections in order: navbar, hero, features, how it works, developer details, footer', () => {
    renderHome();

    // Navbar: brand big on the left, Login + Sign Up on the right.
    expect(screen.getByRole('link', { name: /School Manager/ })).toHaveProperty('href');
    const logins = screen.getAllByRole('link', { name: 'Log in' });
    expect(logins.length).toBe(2); // navbar + hero CTA
    logins.forEach((l) => expect(l.getAttribute('href')).toBe('/login'));
    const signups = screen.getAllByRole('link', { name: 'Sign Up' });
    expect(signups.length).toBe(1);
    expect(signups[0].getAttribute('href')).toBe('/signup');
    expect(screen.getByRole('link', { name: 'Create your school account' }).getAttribute('href')).toBe(
      '/signup',
    );
    // Section order by heading: hero h1, then the h2s in page order.
    const headings = Array.from(document.querySelectorAll('h1, h2')).map((h) => h.textContent);
    expect(headings).toEqual([
      'Run your whole school from one place.',
      'Everything a school needs, in one place',
      'How it works',
      'About the Developer',
    ]);

    // All eight features are present.
    for (const title of [
      'Attendance',
      'Photo OCR student lists',
      'Fees & reminders',
      'Absent SMS alerts',
      'Results & exams',
      'Timetable',
      'Payroll',
      'Certificates & ID cards',
    ]) {
      expect(screen.getByText(title)).toBeTruthy();
    }

    // All three steps are present. (Step 1's title also appears as the
    // hero CTA link, so match-all rather than getByText.)
    for (const step of [
      'Create your school account',
      'Add your classes and students',
      'Run the school day',
    ]) {
      expect(screen.getAllByText(step).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('shows the developer details from config, with working contact links', () => {
    renderHome();

    // Name is big in the developer section (and again in the compact footer).
    expect(screen.getAllByText(DEVELOPER.name).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(DEVELOPER.tagline)).toBeTruthy();
    expect(screen.getByText(DEVELOPER.phone)).toBeTruthy();
    expect(screen.getByText(DEVELOPER.email)).toBeTruthy();
    expect(screen.getByText(DEVELOPER.builtByLine)).toBeTruthy();

    const wa = screen.getByRole('link', { name: DEVELOPER.phone });
    expect(wa.getAttribute('href')).toBe(DEVELOPER.whatsappUrl);
    const mail = screen.getByRole('link', { name: DEVELOPER.email });
    expect(mail.getAttribute('href')).toBe(`mailto:${DEVELOPER.email}`);

    // The developer photo is the configured one — once large in the
    // developer section, once small in the compact footer below it.
    const photos = screen.getAllByAltText(`Photo of ${DEVELOPER.name}`);
    expect(photos.length).toBe(2);
    photos.forEach((p) => expect(p.getAttribute('src')).toBe(DEVELOPER.photo));
  });

  it('contains none of the removed role words anywhere', () => {
    renderHome();
    // The pattern below is the test's own assertion, not page content:
    // it guards the removal done in src/config/developer.ts.
    expect(document.body.textContent).not.toMatch(/freelanc|web designer/i);
  });

  it('gives every section a hover lift and shows the hero mockup', () => {
    renderHome();

    // Hero mockup: an illustration of the product, no real data/numbers.
    const mockup = screen.getByTestId('hero-mockup');
    expect(mockup.className).toContain('hover:-translate-y-1.5');
    expect(screen.getByText(/A peek inside the dashboard/)).toBeTruthy();

    // All eight feature cards rise on hover.
    const cards = document.querySelectorAll('article');
    expect(cards.length).toBe(8);
    cards.forEach((c) => expect(c.className).toContain('hover:-translate-y-1.5'));

    // All three how-it-works step cards rise on hover.
    const steps = document.querySelectorAll('ol li');
    expect(steps.length).toBe(3);
    steps.forEach((s) => expect(s.className).toContain('hover:-translate-y-1.5'));

    // The developer-details panel (LAST section) rises on hover.
    const panel = document.querySelector('section[aria-labelledby="developer-heading"] > div');
    expect(panel?.className).toContain('hover:-translate-y-1.5');

    // Buttons rise on hover too (navbar + hero CTAs).
    const signup = screen.getByRole('link', { name: 'Sign Up' });
    expect(signup.className).toContain('hover:-translate-y-0.5');
  });
});

describe('homepage (logged in)', () => {
  it('redirects a signed-in user to /dashboard', () => {
    authState.user = LOGGED_IN_USER;
    renderHome();
    expect(screen.getByText('Dashboard stub')).toBeTruthy();
    expect(screen.queryByText('Run your whole school from one place.')).toBeNull();
  });
});
