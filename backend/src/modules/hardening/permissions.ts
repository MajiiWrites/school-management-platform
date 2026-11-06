/**
 * Roles & permissions matrix (6A, contracts/SCHEMA.md §2).
 *
 * This is the SAME default matrix the v2 migration SQL and prisma/seed.ts
 * seed into role_permissions (admin 84 rows, clerk 9, principal 12). Keep
 * all three in sync if the matrix changes.
 *
 * Enforcement points: src/middleware/permissions.ts (requirePermission) is
 * applied to every mutating route; admin bypasses (all allowed); principal
 * is view-only (any non-view action is 403).
 */
import type { Db } from '../../lib/db';

export const RESOURCES = [
  'students',
  'fees',
  'results',
  'attendance',
  'classes',
  'messages',
  'reports',
  'settings',
  'users',
  'staff',
  'timetable',
  'exams',
  'announcements',
  'expenses',
] as const;

export const ACTIONS = ['view', 'create', 'update', 'delete', 'approve', 'export'] as const;

export type Resource = (typeof RESOURCES)[number];
export type Action = (typeof ACTIONS)[number];

const VIEW_ONLY_RESOURCES: Resource[] = [
  'students',
  'fees',
  'results',
  'attendance',
  'classes',
  'messages',
  'reports',
  'staff',
  'timetable',
  'exams',
  'announcements',
  'expenses',
];

/** Default allowed (resource, action) pairs per role. Admin = everything. */
export const DEFAULT_MATRIX: Record<string, Array<[string, string]>> = {
  admin: RESOURCES.flatMap((r) => ACTIONS.map((a): [string, string] => [r, a])),
  clerk: [
    ...['students', 'fees', 'results', 'attendance', 'reports'].map((r): [string, string] => [r, 'view']),
    ['students', 'create'],
    ['fees', 'create'],
    ['results', 'create'],
    ['fees', 'update'],
  ],
  principal: VIEW_ONLY_RESOURCES.map((r): [string, string] => [r, 'view']),
};

export interface PermissionRow {
  role: string;
  resource: string;
  action: string;
  allowed: boolean;
}

/**
 * The school's effective permissions for a role: seeded DEFAULT_MATRIX
 * overlaid with any stored role_permissions rows (a stored row wins,
 * including allowed=false customisations made via PATCH /roles/permissions).
 * When a school has no stored rows at all, the defaults apply as-is.
 */
export async function getEffectivePermissions(db: Db, schoolId: string, role: string): Promise<PermissionRow[]> {
  const defaults = new Map<string, PermissionRow>();
  for (const [resource, action] of DEFAULT_MATRIX[role] ?? []) {
    defaults.set(`${resource}:${action}`, { role, resource, action, allowed: true });
  }
  const stored: any[] = await (db as any).rolePermission.findMany({ where: { schoolId, role } });
  for (const row of stored) {
    defaults.set(`${row.resource}:${row.action}`, {
      role,
      resource: row.resource,
      action: row.action,
      allowed: row.allowed,
    });
  }
  return [...defaults.values()];
}

/** Admin bypasses with all allowed; principal is view-only; otherwise read the matrix. */
export async function isAllowed(
  db: Db,
  schoolId: string,
  role: string,
  resource: string,
  action: string,
): Promise<boolean> {
  if (role === 'admin') return true;
  if (role === 'principal') return action === 'view' && VIEW_ONLY_RESOURCES.includes(resource as Resource);
  const perms = await getEffectivePermissions(db, schoolId, role);
  return perms.some((p) => p.resource === resource && p.action === action && p.allowed);
}
