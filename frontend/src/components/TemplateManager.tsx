// Template manager — Section 11 (Custom Messages).
// Full CRUD over /messages/templates. NOTHING is locked: seeded defaults
// edit, rename, duplicate and delete exactly like custom templates.
// Deletes go through ConfirmDialog; the backend snapshots the row into the
// recycle bin. All forms carry autoComplete="off".

import { useState } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { CustomMessageType, MessageTemplateRow } from '../lib/types';
import { MESSAGE_VARIABLES } from '../lib/types';
import { Badge, Button, Card, EmptyState, inputCls, useToast } from '../components/ui';
import Tooltip from './Tooltip'; // P8-TOUR: plain-word tooltip on "recycle bin".
import ConfirmDialog from '../components/ConfirmDialog';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

const TYPE_LABEL: Record<CustomMessageType, string> = {
  absent: 'Absent alert',
  fee_reminder: 'Fee reminder',
  teacher_reminder: 'Teacher reminder',
  result: 'Result',
  announcement: 'Announcement',
  custom: 'Custom',
};

const TYPE_OPTIONS: CustomMessageType[] = [
  'absent',
  'fee_reminder',
  'teacher_reminder',
  'result',
  'announcement',
  'custom',
];

export default function TemplateManager({
  templates,
  onSaved,
}: {
  templates: MessageTemplateRow[];
  onSaved: () => void;
}) {
  const [lang, setLang] = useState<'en' | 'ur'>('en');
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createType, setCreateType] = useState<CustomMessageType>('custom');
  const [createBody, setCreateBody] = useState('');
  const [editing, setEditing] = useState<MessageTemplateRow | null>(null);
  const [editName, setEditName] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editType, setEditType] = useState<CustomMessageType>('custom');
  const [deleting, setDeleting] = useState<MessageTemplateRow | null>(null);
  const [busy, setBusy] = useState(false);
  const { push, view } = useToast();

  const shown = templates.filter((t) => t.language === lang);

  const create = async () => {
    setBusy(true);
    try {
      await api('/messages/templates', {
        method: 'POST',
        body: { name: createName.trim(), type: createType, language: lang, body: createBody.trim() },
      });
      push('success', 'Template created.');
      setShowCreate(false);
      setCreateName('');
      setCreateBody('');
      setCreateType('custom');
      onSaved();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await api(`/messages/templates/${editing.id}`, {
        method: 'PATCH',
        body: { name: editName.trim(), body: editBody.trim(), type: editType },
      });
      push('success', 'Template saved.');
      setEditing(null);
      onSaved();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async (t: MessageTemplateRow) => {
    setBusy(true);
    try {
      await api(`/messages/templates/${t.id}/duplicate`, { method: 'POST' });
      push('success', `Duplicated as a custom template.`);
      onSaved();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: MessageTemplateRow) => {
    setBusy(true);
    try {
      await api(`/messages/templates/${t.id}`, { method: 'DELETE' });
      push('success', 'Template deleted (snapshot kept in the recycle bin).');
      onSaved();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={lang === 'en' ? 'primary' : 'secondary'} onClick={() => setLang('en')}>English</Button>
        <Button variant={lang === 'ur' ? 'primary' : 'secondary'} onClick={() => setLang('ur')}>اردو</Button>
        <span className="flex-1" />
        <Button onClick={() => setShowCreate((v) => !v)}>{showCreate ? 'Close form' : 'New template'}</Button>
      </div>
      <p className="text-sm text-slate-500">
        Variables: {MESSAGE_VARIABLES.map((v) => `{${v}}`).join(' ')}
      </p>
      <p className="text-sm text-slate-500">
        Nothing is locked — seeded defaults can be edited, renamed, duplicated or deleted just like your own templates.
        Deleted templates are kept in the recycle bin
        <Tooltip text="The recycle bin keeps deleted items for 30 days. A deleted template's saved copy can be brought back during that time; after 30 days it is gone for good." />
        {' '}for 30 days.
      </p>

      {showCreate && (
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-slate-900">New template ({lang === 'ur' ? 'Urdu' : 'English'})</h3>
          <form autoComplete="off" onSubmit={(e) => { e.preventDefault(); create(); }}>
            <label className="mt-3 block text-xs font-medium text-slate-600">Name</label>
            <input className={inputCls} value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="e.g. Exam result (EN)" autoComplete="off" />
            <label className="mt-3 block text-xs font-medium text-slate-600">Type</label>
            <select className={inputCls} value={createType} onChange={(e) => setCreateType(e.target.value as CustomMessageType)} autoComplete="off">
              {TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>{TYPE_LABEL[t]}</option>
              ))}
            </select>
            <label className="mt-3 block text-xs font-medium text-slate-600">Message text</label>
            <textarea className={`${inputCls} ${lang === 'ur' ? 'urdu' : ''}`} dir={lang === 'ur' ? 'rtl' : 'ltr'} rows={4} value={createBody} onChange={(e) => setCreateBody(e.target.value)} autoComplete="off" />
            <div className="mt-3">
              <Button disabled={busy || !createName.trim() || !createBody.trim()} onClick={create}>
                {busy ? 'Creating…' : 'Create template'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {shown.length === 0 && (
        <EmptyState
          title="No templates for this language"
          body="Create your first template above — or switch language."
          actionLabel="New template"
          onAction={() => setShowCreate(true)}
        />
      )}

      {shown.map((t) => {
        const isEditing = editing?.id === t.id;
        return (
          <Card key={t.id} className="p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-900">{t.name ?? TYPE_LABEL[t.type]}</h3>
              <Badge tone="slate">{TYPE_LABEL[t.type]}</Badge>
              <Badge tone={t.isCustom ? 'green' : 'slate'}>{t.isCustom ? 'Custom' : 'Default'}</Badge>
              {!t.isActive && <Badge tone="amber">Inactive</Badge>}
              <span className="flex-1" />
              {!isEditing && (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setEditing(t);
                      setEditName(t.name ?? '');
                      setEditBody(t.body);
                      setEditType(t.type);
                    }}
                  >
                    Edit
                  </Button>
                  <Button variant="secondary" disabled={busy} onClick={() => duplicate(t)}>Duplicate</Button>
                  <Button variant="secondary" onClick={() => setDeleting(t)}>Delete</Button>
                </>
              )}
            </div>
            {isEditing ? (
              <form autoComplete="off" onSubmit={(e) => { e.preventDefault(); saveEdit(); }}>
                <label className="mt-3 block text-xs font-medium text-slate-600">Name</label>
                <input className={inputCls} value={editName} onChange={(e) => setEditName(e.target.value)} autoComplete="off" />
                <label className="mt-3 block text-xs font-medium text-slate-600">Type</label>
                <select className={inputCls} value={editType} onChange={(e) => setEditType(e.target.value as CustomMessageType)} autoComplete="off">
                  {TYPE_OPTIONS.map((ty) => (
                    <option key={ty} value={ty}>{TYPE_LABEL[ty]}</option>
                  ))}
                </select>
                <label className="mt-3 block text-xs font-medium text-slate-600">Message text</label>
                <textarea
                  className={`${inputCls} ${lang === 'ur' ? 'urdu' : ''}`}
                  dir={lang === 'ur' ? 'rtl' : 'ltr'}
                  rows={4}
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  autoComplete="off"
                />
                <p className="mt-1 text-xs text-slate-500">
                  {editBody.length} characters · {Math.max(1, Math.ceil(editBody.length / 160))} SMS segment(s) (estimate — the live preview counts Urdu correctly)
                </p>
                <div className="mt-2 flex gap-2">
                  <Button disabled={busy || !editName.trim() || !editBody.trim()} onClick={saveEdit}>
                    {busy ? 'Saving…' : 'Save template'}
                  </Button>
                  <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
                </div>
              </form>
            ) : (
              <p className={`mt-2 text-sm text-slate-600 ${lang === 'ur' ? 'urdu' : ''}`} dir={lang === 'ur' ? 'rtl' : 'ltr'}>
                {t.body}
              </p>
            )}
          </Card>
        );
      })}

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this template?"
        message={
          deleting
            ? `Are you sure? This will permanently delete "${deleting.name ?? TYPE_LABEL[deleting.type]}" (${deleting.language === 'ur' ? 'Urdu' : 'English'}). A snapshot is kept in the recycle bin. Messages already queued are not affected.`
            : ''
        }
        confirmLabel="Delete template"
        tone="danger"
        busy={busy}
        onConfirm={() => {
          const d = deleting;
          setDeleting(null);
          if (d) void remove(d);
        }}
        onCancel={() => setDeleting(null)}
      />
      {view}
    </div>
  );
}
