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
// --- Section 11 (Custom Messages) --------------------------------------
export {
  approveDraftForSending,
  applyApprovedDraft,
  previewMessage,
  processDueScheduledDrafts,
  sendDraft,
  validateDraftInput,
  schoolLocalDate,
} from './custom-messages';
export type {
  CustomMessagesDeps,
  PreviewResult,
  PreviewSample,
  RecipientSkip,
  SendResult,
} from './custom-messages';
export { createPrismaMessagingStore } from './store';
export type { MessagingStore, QueueRow, TemplateRow, DeviceRow, DraftRow, RecipientStudent } from './store';
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
