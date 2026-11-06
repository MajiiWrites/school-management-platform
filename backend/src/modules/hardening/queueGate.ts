/**
 * Queue gate (6A): clerk calls to mutating endpoints go through the approval
 * queue instead of applying directly. Returns true (and sends the 202) when
 * the caller is a clerk; returns false when the caller is an admin and the
 * route should apply the change directly. Principals never reach here —
 * requireAdminOrClerk / requirePermission reject them with 403 first.
 */
import type { Request, Response } from 'express';
import { getDb } from '../../lib/db';
import { schoolIdOf } from '../../middleware/tenant';
import { createApprovalRequest } from './approvals';

export async function queueIfClerk(
  req: Request,
  res: Response,
  input: { actionType: 'create' | 'update' | 'delete' | 'bulk'; entity: string; entityId?: string | null; payload: Record<string, unknown> },
): Promise<boolean> {
  if (req.user?.role !== 'clerk') return false;
  const created = await createApprovalRequest(getDb(), {
    schoolId: schoolIdOf(req),
    requestedBy: req.user.sub,
    actionType: input.actionType,
    entity: input.entity,
    entityId: input.entityId ?? null,
    payload: input.payload,
  });
  res.status(202).json({
    ok: true,
    data: {
      approval_request_id: created.id,
      status: 'pending',
      action_type: input.actionType,
      entity: input.entity,
      message: 'Submitted for admin approval — nothing was applied yet.',
    },
  });
  return true;
}
