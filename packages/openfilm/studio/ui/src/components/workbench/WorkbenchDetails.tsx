import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUpRight, X } from 'lucide-react';
import { useT } from '@/i18n';
import { dateTimeInput, productionPatch, PRODUCTION_STATUSES, type Video, type VideoPatch } from '@/lib/workbench';
import { CardButton } from '../Card';
import WorkbenchAnalytics from './WorkbenchAnalytics';
import { WorkbenchReview } from './WorkbenchReview';

export const PLATFORMS = ['douyin', 'xiaohongshu', 'bilibili', 'wechat', 'kuaishou', 'youtube', 'tiktok', 'other'] as const;

const FIELD = 'h-9 min-w-0 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-field)] px-2.5 text-[13px] text-[var(--text)]';

function Field({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 text-[12px] font-medium text-[var(--text-muted)] ${wide ? 'sm:col-span-2' : ''}`}>
      {title}
      {children}
    </label>
  );
}

export function WorkbenchDetails({ video, onClose, onSave, onOpenProject, onChange, revision }: {
  video: Video;
  onClose: () => void;
  onSave: (patch: VideoPatch) => Promise<void>;
  onOpenProject: (id: string) => void;
  onChange: () => void;
  revision: number;
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const [initial] = useState(video);
  const [page, setPage] = useState<'details' | 'performance' | 'reviewLabel'>('details');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      // The original button may have moved to a different column or date.
      requestAnimationFrame(() => {
        if (document.activeElement !== document.body) return;
        const updated = document.querySelector<HTMLElement>(`[data-workbench-video="${CSS.escape(video.id)}"]`);
        (updated ?? document.querySelector<HTMLElement>('[data-workbench-view][aria-pressed="true"]'))?.focus();
      });
    };
  }, [video.id]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const patch = productionPatch(initial, new FormData(event.currentTarget));
    setSaving(true);
    setError('');
    try {
      if (Object.keys(patch).length) await onSave(patch);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby="workbench-details-title"
      onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}
      className="m-auto max-h-[calc(100dvh-32px)] w-[min(740px,calc(100vw-32px))] overflow-auto rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-raised)] p-0 text-[var(--text)] shadow-[var(--shadow-lg)] backdrop:bg-black/45"
    >
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg-raised)] px-5 pt-4 sm:px-6">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 id="workbench-details-title" className="break-words text-[20px] font-semibold leading-tight">{video.title}</h2>
            <p className="mt-1 truncate text-[12px] text-[var(--text-muted)]" title={video.projectPath}>{video.projectPath}</p>
          </div>
          <CardButton className="shrink-0" onClick={() => { onClose(); onOpenProject(video.projectId); }} disabled={video.missing || saving}>
            {t('workbench.openProject')}<ArrowUpRight size={13} />
          </CardButton>
          <CardButton weight="quiet" className="!px-1.5" onClick={onClose} disabled={saving} aria-label={t('workbench.close')}>
            <X size={17} />
          </CardButton>
        </div>
        <nav aria-label={t('workbench.details')} className="mt-3 flex gap-3">
          {(['details', 'performance', 'reviewLabel'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              aria-current={page === tab ? 'page' : undefined}
              onClick={() => setPage(tab)}
              disabled={saving}
              className={`border-b-2 px-1 pb-2 text-[13px] font-medium ${page === tab ? 'border-[var(--accent)] text-[var(--text)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'}`}
            >
              {t(`workbench.${tab}`)}
            </button>
          ))}
        </nav>
      </header>
      <div className="p-5 sm:p-6">
        <form onSubmit={(event) => void submit(event)} hidden={page !== 'details'}>
          {video.missing ? <p className="mb-4 text-[13px] text-[var(--warn)]">{t('workbench.missing')}</p> : null}
          <fieldset disabled={video.missing || saving} className="grid gap-4 sm:grid-cols-2">
            <Field title={t('workbench.status')}>
              <select name="status" defaultValue={initial.status} className={FIELD}>
                {PRODUCTION_STATUSES.map((status) => <option key={status} value={status}>{t(`workbench.statuses.${status}`)}</option>)}
              </select>
            </Field>
            <Field title={t('workbench.platform')}>
              <select name="platform" defaultValue={initial.platform ?? ''} className={FIELD}>
                <option value="">{t('workbench.unassigned')}</option>
                {initial.platform && !PLATFORMS.some((platform) => platform === initial.platform) ? <option value={initial.platform}>{initial.platform}</option> : null}
                {PLATFORMS.map((platform) => <option key={platform} value={platform}>{t(`workbench.platforms.${platform}`)}</option>)}
              </select>
            </Field>
            <Field title={t('workbench.scheduledAt')}>
              <input type="datetime-local" name="scheduledAt" defaultValue={dateTimeInput(initial.scheduledAt)} className={FIELD} />
            </Field>
            <Field title={t('workbench.publishedAt')}>
              <input type="datetime-local" name="publishedAt" defaultValue={dateTimeInput(initial.publishedAt)} className={FIELD} />
            </Field>
            <Field title={t('workbench.videoUrl')} wide>
              <input type="url" name="videoUrl" defaultValue={initial.videoUrl ?? ''} placeholder="https://" className={FIELD} />
            </Field>
            <Field title={t('workbench.tags')}>
              <input name="tags" defaultValue={initial.tags.join(', ')} placeholder={t('workbench.tagsHint')} className={FIELD} />
            </Field>
            <Field title={t('workbench.hook')}>
              <input name="hook" defaultValue={initial.hook ?? ''} className={FIELD} />
            </Field>
          </fieldset>
          {error ? <p role="alert" className="mt-3 text-[13px] text-[var(--err)]">{error}</p> : null}
          {!video.missing ? (
            <div className="mt-5 flex justify-end">
              <CardButton weight="primary" type="submit" disabled={saving}>{t(saving ? 'workbench.saving' : 'workbench.save')}</CardButton>
            </div>
          ) : null}
        </form>
        {page === 'performance' ? <WorkbenchAnalytics video={video} onChange={onChange} refreshKey={revision} /> : null}
        {page === 'reviewLabel' ? <WorkbenchReview video={video} revision={revision} /> : null}
      </div>
    </dialog>
  );
}
