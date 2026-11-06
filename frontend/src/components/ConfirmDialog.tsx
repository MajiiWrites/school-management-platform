import { Button, Modal } from './ui';

/**
 * Shared confirmation dialog — the ONLY confirmation UI in the app.
 * Every add / delete / bulk / destructive action must open this dialog
 * and run its API call ONLY from onConfirm. Never call window.confirm().
 *
 * Usage:
 *   const [pending, setPending] = useState<null | { label: string }>(null);
 *   <ConfirmDialog
 *     open={pending !== null}
 *     title="Delete class?"
 *     message="Are you sure? This will remove Class 5-A. This cannot be undone."
 *     confirmLabel="Delete class"
 *     tone="danger"
 *     onConfirm={() => { setPending(null); doDelete(); }}
 *     onCancel={() => setPending(null)}
 *   />
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="text-sm text-slate-700">{message}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
