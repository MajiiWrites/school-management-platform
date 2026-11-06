/**
 * Messaging module — public surface.
 * The integration phase mounts createMessagingRouter() in app.ts (see MOUNT.md).
 */
export { createMessagingRouter, messagingErrorStatus } from './routes';
export type { MessagingRouterDeps, AuthedRequest } from './routes';
export {
  buildAbsentDrafts,
  buildFeeReminderDrafts,
  buildTeacherReminderDraft,
  getPendingApproval,
  approveMessages,
  editQueueBody,
  retryFailed,
  getDeviceQueue,
  reportDelivery,
  getSmsStatus,
} from './service';
export type { ServiceDeps, DraftResult } from './service';
export { createPrismaMessagingStore } from './store';
export type { MessagingStore, QueueRow, TemplateRow, DeviceRow } from './store';
export {
  normalizePK,
  isValidPK,
  maskPhone,
  hashPhone,
  encryptPhone,
  decryptPhone,
  deriveDeviceKey,
} from './phone';
export { DEFAULT_TEMPLATES, renderTemplate } from './templates';
export { sendViaGateway, dispatchViaSim } from './providers';
