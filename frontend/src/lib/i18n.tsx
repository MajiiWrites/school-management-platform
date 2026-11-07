// UI language (6C-2) — settings.language ('en' | 'ur').
// COVERAGE (honest): navigation labels + the new 6C-2 page headings only.
// Forms, table data, validation messages and all pre-existing pages stay
// in English — translating those is a separate pass. The setting persists
// on the backend (PATCH /settings {language}); this provider reads it once
// at login and keeps it in localStorage so the nav renders in the chosen
// language on the next visit too.

import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { cachedApiGet } from './api';

export type UiLang = 'en' | 'ur';

const NAV_LABELS: Record<string, { en: string; ur: string }> = {
  dashboard: { en: 'Dashboard', ur: 'ڈیش بورڈ' },
  classes: { en: 'Classes', ur: 'کلاسیں' },
  students: { en: 'Students', ur: 'طلبہ' },
  parents: { en: 'Parents', ur: 'والدین' },
  fees: { en: 'Fees', ur: 'فیس' },
  messages: { en: 'Messages', ur: 'پیغامات' },
  reports: { en: 'Reports', ur: 'رپورٹس' },
  settings: { en: 'Settings', ur: 'ترتیبات' },
  expenses: { en: 'Expenses', ur: 'اخراجات' },
  announcements: { en: 'Announcements', ur: 'اعلانات' },
  events: { en: 'Events & Calendar', ur: 'تقریبات اور کیلنڈر' },
  certificates: { en: 'Certificates', ur: 'اسناد' },
  notifications: { en: 'Notifications', ur: 'اطلاعات' },
  // Keys owned by other phases (kept in English + Urdu so the nav never
  // falls back to a raw key).
  results: { en: 'Results', ur: 'نتائج' },
  sessions: { en: 'Sessions', ur: 'تعلیمی سیشن' },
  exams: { en: 'Exams', ur: 'امتحانات' },
  timetable: { en: 'Timetable', ur: 'ٹائم ٹیبل' },
  'staff-payroll': { en: 'Staff & payroll', ur: 'عملہ اور تنخواہ' },
  // P8-TOUR: Help page nav label.
  help: { en: 'Help', ur: 'مدد' },
  security: { en: 'Security', ur: 'سیکیورٹی' },
  approvals: { en: 'Approval Queue', ur: 'منظوری کی قطار' },
  // D1: Recycle Bin + Change History nav labels.
  'recycle-bin': { en: 'Recycle Bin', ur: 'ری سائیکل بن' },
  'change-history': { en: 'Change History', ur: 'تبدیلیوں کی تاریخ' },
};

const PAGE_TITLES: Record<string, { en: string; ur: string }> = {
  expenses: { en: 'Expenses', ur: 'اخراجات' },
  announcements: { en: 'Announcements', ur: 'اعلانات' },
  events: { en: 'Events & Calendar', ur: 'تقریبات اور کیلنڈر' },
  certificates: { en: 'Certificates & ID Cards', ur: 'اسناد اور شناختی کارڈ' },
  notifications: { en: 'Notification Center', ur: 'اطلاعاتی مرکز' },
};

interface LangCtx {
  lang: UiLang;
  setLang: (l: UiLang) => void;
  nav: (key: string) => string;
  title: (key: string) => string;
}

const Ctx = createContext<LangCtx>({ lang: 'en', setLang: () => undefined, nav: (k) => NAV_LABELS[k]?.en ?? k, title: (k) => PAGE_TITLES[k]?.en ?? k });

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<UiLang>(() => (localStorage.getItem('smp_lang') === 'ur' ? 'ur' : 'en'));

  // Round 5 (F2): the language fetch is cached per session for 5 minutes
  // (cachedApiGet) — it fired on every full app mount. A language change
  // saved in Settings clears the cache (see Settings.tsx doSave), so the
  // new language still applies on the next mount without waiting.
  useEffect(() => {
    cachedApiGet<{ language?: string }>('/settings')
      .then((s) => {
        if (s.language === 'ur' || s.language === 'en') {
          setLangState(s.language);
          localStorage.setItem('smp_lang', s.language);
        }
      })
      .catch(() => undefined);
  }, []);

  const setLang = (l: UiLang) => {
    setLangState(l);
    localStorage.setItem('smp_lang', l);
    document.documentElement.lang = l === 'ur' ? 'ur' : 'en';
  };

  useEffect(() => {
    document.documentElement.lang = lang === 'ur' ? 'ur' : 'en';
  }, [lang]);

  const nav = (key: string) => NAV_LABELS[key]?.[lang] ?? key;
  const title = (key: string) => PAGE_TITLES[key]?.[lang] ?? key;
  return <Ctx.Provider value={{ lang, setLang, nav, title }}>{children}</Ctx.Provider>;
}

export function useLanguage(): LangCtx {
  return useContext(Ctx);
}
