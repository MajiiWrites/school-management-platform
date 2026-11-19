// College Mode helpers — org-type gating + GPA formatting.
// The org type comes from the existing GET /settings payload (org_type),
// via the same 5-minute cached getter the language provider already
// uses — no new endpoint, no extra fetch per navigation.
import { useEffect, useState } from 'react';
import { cachedApiGet } from './api';
import type { SchoolSettings } from './types';

export function isCollegeOrg(orgType: string | null | undefined): boolean {
  return orgType === 'College';
}

/** Nav-gating predicate used by Layout: the College nav section renders
 * only for College orgs. */
export function showCollegeNav(orgType: string | null | undefined): boolean {
  return isCollegeOrg(orgType);
}

/** 'College' | 'School' | null (null = not known yet / fetch failed).
 * Fail-closed: callers treat null as "not College", so College UI is
 * never shown to a School org — at worst it appears a moment late. */
export function useOrgType(): { orgType: string | null; loading: boolean } {
  const [orgType, setOrgType] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    cachedApiGet<SchoolSettings>('/settings')
      .then((s) => {
        if (alive) setOrgType(s.org_type ?? null);
      })
      .catch(() => {
        if (alive) setOrgType(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  return { orgType, loading };
}

export function useIsCollege(): { isCollege: boolean; loading: boolean } {
  const { orgType, loading } = useOrgType();
  return { isCollege: isCollegeOrg(orgType), loading };
}

/** GPA/CGPA display: 2 decimals, '—' when there is nothing to show yet
 * (null = no marks recorded for that semester / student). */
export function formatGpa(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toFixed(2);
}

/** Percentage display for a course row. */
export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${Math.round(value * 100) / 100}%`;
}

export const COLLEGE_NOT_AVAILABLE_TEXT =
  'College Mode is not available for your organization type. This section is only for colleges — your organization is registered as a school.';
