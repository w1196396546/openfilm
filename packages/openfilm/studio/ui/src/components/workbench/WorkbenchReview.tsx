import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, studioCall, type MediaFile } from '@/api';
import { useLanguage, useT } from '@/i18n';
import type { Video } from '@/lib/workbench';
import { CardButton } from '../Card';

type Review = {
  model: string;
  createdAt: number;
  capturedAt: number;
  findings: string;
  hypotheses: string;
  nextTest: string;
};

type Variant = {
  label: 'A' | 'B';
  title: string | null;
  cover: string | null;
  impressions: number | null;
  clicks: number | null;
};

type ReviewData = {
  review: Review | null;
  variants: Variant[];
  modelReady: boolean;
  snapshotReady: boolean;
};
type VariantDraft = Partial<Record<'title' | 'cover' | 'impressions' | 'clicks', string>>;

type Hook = { kind: string; text: string; createdAt: number };

const FIELD = 'w-full min-w-0 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-field)] px-2.5 py-2 text-[13px] text-[var(--text)]';
const LABEL = 'flex min-w-0 flex-col gap-1 text-[12px] font-medium text-[var(--text-muted)]';
const HINT = 'text-[12px] leading-relaxed text-[var(--text-muted)]';
const ERROR = 'text-[13px] text-[var(--err)]';
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function WorkbenchReview({ video, revision }: { video: Video; revision?: number }) {
  const t = useT();
  const language = useLanguage();
  const [data, setData] = useState<ReviewData | null>(null);
  const [images, setImages] = useState<MediaFile[]>([]);
  const [drafts, setDrafts] = useState<Partial<Record<Variant['label'], VariantDraft>>>({});
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const path = `workbench/videos/${encodeURIComponent(video.id)}`;

  useEffect(() => {
    let active = true;
    void studioCall<ReviewData>(`${path}/review`).then((result) => {
      if (active) setData(result);
    }).catch((cause) => {
      if (active) setError(errorText(cause));
    });
    return () => { active = false; };
  }, [path, reload, revision, video.latestSnapshot?.capturedAt, video.platform, video.publishedAt]);

  useEffect(() => {
    if (video.missing) return;
    let active = true;
    void api.files(video.projectId).then((result) => {
      if (active) setImages(result.files.filter((file) => file.kind === 'image' && file.size > 0));
    }).catch((cause) => {
      if (active) setError(errorText(cause));
    });
    return () => { active = false; };
  }, [video.projectId, video.missing, reload]);

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const notes = new FormData(event.currentTarget).get('notes');
    setPending('review');
    setError('');
    setSaved('');
    try {
      const result = await studioCall<{ review: Review }>(`${path}/review`, { method: 'POST', json: { notes, language } });
      setData((value) => value && { ...value, review: result.review });
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.body.code : null;
      setError(code === 'review-snapshot' ? t('workbench.review.snapshotMissing')
        : code === 'review-model' ? t('workbench.review.modelMissing') : errorText(cause));
    } finally {
      setPending('');
    }
  }

  async function saveVariant(label: Variant['label'], event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const number = (key: string) => form.get(key) === '' ? null : Number(form.get(key));
    setPending(label);
    setError('');
    setSaved('');
    try {
      const result = await studioCall<{ variants: Variant[] }>(`${path}/variants`, { method: 'POST', json: {
        label, title: form.get('title'), cover: form.get('cover'), impressions: number('impressions'), clicks: number('clicks'),
      } });
      setData((value) => value && { ...value, variants: result.variants });
      setDrafts((value) => ({ ...value, [label]: undefined }));
      setSaved(t('workbench.review.saved').replace('{label}', label));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending('');
    }
  }

  if (!data) {
    if (!error) return <p className={HINT}>{t('workbench.review.loading')}</p>;
    return <div className="space-y-2"><p role="alert" className={ERROR}>{error}</p><CardButton onClick={() => { setError(''); setReload(reload + 1); }}>{t('workbench.review.retry')}</CardButton></div>;
  }

  const review = data.review;
  const blocker = video.missing ? 'projectMissing' : !data.snapshotReady ? 'snapshotMissing' : !data.modelReady ? 'modelMissing' : null;
  const percent = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 2 });

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-[15px] font-semibold">{t('workbench.review.attribution')}</h3>
        {review ? (
          <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--bg-field)] p-3">
            <p className={HINT}>
              {t('workbench.review.snapshotDate').replace('{date}', new Date(review.capturedAt).toLocaleString(language))}
              {' · '}{review.model}
            </p>
            <dl className="space-y-3">
              {(['findings', 'hypotheses', 'nextTest'] as const).map((field) => (
                <div key={field}>
                  <dt className="text-[13px] font-semibold">{t(`workbench.review.${field}`)}</dt>
                  <dd className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed">{review[field]}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
        {blocker ? <p className={HINT}>{t(`workbench.review.${blocker}`)}</p> : (
          <form className="space-y-2" onSubmit={(event) => void generate(event)}>
            <label className={LABEL}>
              {t('workbench.review.notes')}
              <textarea name="notes" rows={3} maxLength={2000} placeholder={t('workbench.review.notesHint')} className={FIELD} />
            </label>
            <p className={HINT}>{t('workbench.review.modelHint')}</p>
            <CardButton weight="primary" type="submit" disabled={!!pending}>
              {t(`workbench.review.${pending === 'review' ? 'generating' : review ? 'regenerate' : 'generate'}`)}
            </CardButton>
          </form>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-[15px] font-semibold">{t('workbench.review.variants')}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {(['A', 'B'] as const).map((label) => {
            const variant = data.variants.find((item) => item.label === label);
            const draft = drafts[label];
            const cover = draft?.cover ?? variant?.cover ?? '';
            const hasCover = images.some((image) => image.path === cover);
            const change = (field: keyof VariantDraft, value: string) =>
              setDrafts((old) => ({ ...old, [label]: { ...old[label], [field]: value } }));
            const rate = variant?.impressions && variant.clicks != null ? percent.format(variant.clicks / variant.impressions) : '—';
            return (
              <form key={label} onSubmit={(event) => void saveVariant(label, event)} className="min-w-0 space-y-2 rounded-xl border border-[var(--border)] p-3">
                <h4 className="font-semibold">{label}</h4>
                {cover && hasCover ? (
                  <img className="h-28 w-full rounded-lg bg-[var(--bg-field)] object-contain"
                    alt="" src={`/api/projects/${encodeURIComponent(video.projectId)}/media?what=frame&ms=0&w=360&path=${encodeURIComponent(cover)}`} />
                ) : null}
                <label className={LABEL}>
                  {t('workbench.review.title')}
                  <input name="title" className={FIELD} value={draft?.title ?? variant?.title ?? ''} maxLength={240}
                    disabled={pending === label} onChange={(event) => change('title', event.target.value)} />
                </label>
                <label className={LABEL}>
                  {t('workbench.review.cover')}
                  <select name="cover" className={FIELD} value={cover} disabled={pending === label}
                    onChange={(event) => change('cover', event.target.value)}>
                    <option value="">{t('workbench.review.noCover')}</option>
                    {cover && !hasCover ? <option value={cover}>{cover}</option> : null}
                    {images.map((image) => <option value={image.path} key={image.path}>{image.path}</option>)}
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {(['impressions', 'clicks'] as const).map((metric) => (
                    <label key={metric} className={LABEL}>
                      {t(`workbench.review.${metric}`)}
                      <input type="number" min={0} step={1} name={metric} className={FIELD} value={draft?.[metric] ?? variant?.[metric] ?? ''}
                        disabled={pending === label} onChange={(event) => change(metric, event.target.value)} />
                    </label>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className={HINT}>{t('workbench.review.ctr')} {rate}</span>
                  <CardButton type="submit" disabled={!!pending}>{t('workbench.review.save')}</CardButton>
                </div>
              </form>
            );
          })}
        </div>
        {saved ? <p role="status" className={HINT}>{saved}</p> : null}
      </section>
      {error ? <p role="alert" className={ERROR}>{error}</p> : null}
    </div>
  );
}

export function WorkbenchHooks({ revision }: { revision?: number }) {
  const t = useT();
  const [hooks, setHooks] = useState<Hook[] | null>(null);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  useEffect(() => {
    let active = true;
    void studioCall<{ hooks: Hook[] }>('workbench/hooks').then((result) => {
      if (active) setHooks(result.hooks);
    }).catch((cause) => {
      if (active) setError(errorText(cause));
    });
    return () => { active = false; };
  }, [revision]);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setError('');
    try {
      const json = Object.fromEntries(new FormData(form));
      const result = await studioCall<{ hooks: Hook[] }>('workbench/hooks', { method: 'POST', json });
      setHooks(result.hooks);
      setQuery('');
      form.reset();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  }

  const visible = hooks?.filter((hook) => `${hook.kind} ${hook.text}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  return (
    <section className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--bg-raised)] p-4">
      <h2 className="text-[16px] font-semibold">{t('workbench.review.hooks')}</h2>
      <form className="grid items-end gap-2 sm:grid-cols-[1fr_2fr_auto]" onSubmit={(event) => void add(event)}>
        <label className={LABEL}>
          {t('workbench.review.hookKind')}
          <input name="kind" maxLength={80} required className={FIELD} />
        </label>
        <label className={LABEL}>
          {t('workbench.review.hookText')}
          <input name="text" maxLength={1000} required className={FIELD} />
        </label>
        <CardButton type="submit" disabled={pending}>{t('workbench.review.hookAdd')}</CardButton>
      </form>
      {!!hooks?.length && <input type="search" aria-label={t('workbench.review.hookFilter')} placeholder={t('workbench.review.hookFilter')}
        value={query} onChange={(event) => setQuery(event.target.value)} className={FIELD} />}
      {visible.length ? (
        <ul className="divide-y divide-[var(--border)]">
          {visible.map((hook) => {
            const key = JSON.stringify([hook.kind, hook.text]);
            return (
              <li className="flex items-start gap-3 py-2" key={key}>
                <div className="min-w-0 flex-1">
                  <p className={HINT}>{hook.kind}</p>
                  <p className="break-words text-[13px]">{hook.text}</p>
                </div>
                <CardButton weight="quiet" onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(hook.text);
                    setCopied(key);
                  } catch (cause) {
                    setError(errorText(cause));
                  }
                }}>{t(`workbench.review.${copied === key ? 'copied' : 'copy'}`)}</CardButton>
              </li>
            );
          })}
        </ul>
      ) : hooks ? <p className={HINT}>{t(hooks.length ? 'workbench.review.noMatches' : 'workbench.review.noHooks')}</p> : null}
      {error ? <p role="alert" className={ERROR}>{error}</p> : null}
    </section>
  );
}
