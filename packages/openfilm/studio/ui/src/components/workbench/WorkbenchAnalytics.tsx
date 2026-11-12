import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Download } from 'lucide-react';
import { studioCall } from '../../api';
import { useLanguage, useT } from '../../i18n';

const METRICS = ['views', 'likes', 'comments', 'shares', 'saves', 'followersDelta'] as const;
type Metric = typeof METRICS[number];
type Snapshot = Record<Metric, number | null> & { platform: string; capturedAt: number; source: string };
type Series = { snapshots: Snapshot[]; milestones: { days: number; snapshot: Snapshot | null }[] };
type Video = { id: string; platform: string | null; publishedAt: number | null };

const LABEL = 'grid content-start gap-1 text-xs text-[var(--text-muted)]';
const FIELD = 'min-w-0 rounded-md border border-[var(--border-strong)] bg-[var(--bg-field)] px-2 py-1.5 text-sm text-[var(--text)]';
const BUTTON = 'inline-flex w-fit items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-raised)] px-2.5 py-1.5 text-xs font-medium text-[var(--text)] hover:bg-[var(--bg-hover)] disabled:opacity-50';
const CELL = 'border-b border-[var(--border)] px-2 py-1.5 whitespace-nowrap tabular-nums';
const word = (key: string) => `workbench.analytics.${key}`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function localDateTime() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function Trend({ rows, metric }: { rows: Snapshot[]; metric: Metric }) {
  const title = useId();
  const t = useT();
  const language = useLanguage();
  const data = rows.flatMap((row) => row[metric] == null ? [] : [{ time: row.capturedAt, value: row[metric] }]);
  if (!data.length) return <p className="text-xs text-[var(--text-muted)]">{t(word('none'))}</p>;
  let low = Math.min(0, data[0].value);
  let high = Math.max(0, data[0].value);
  for (const point of data) {
    low = Math.min(low, point.value);
    high = Math.max(high, point.value);
  }
  const first = data[0].time;
  const last = data[data.length - 1].time;
  const points = data.map(({ time, value }) => [first === last ? 240 : 5 + 470 * (time - first) / (last - first),
    94 - 88 * (value - low) / (high - low || 1)]);
  const number = new Intl.NumberFormat(language);
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' });
  return (
    <figure className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-xs text-[var(--text-muted)]">
      <div aria-hidden="true" className="flex flex-col justify-between text-right tabular-nums"><span>{number.format(high)}</span><span>{number.format(low)}</span></div>
      <svg viewBox="0 0 480 100" preserveAspectRatio="none" className="h-24 w-full rounded-md bg-[var(--bg-field)] text-[var(--accent)]" role="img" aria-labelledby={title}>
        <title id={title}>{`${t(word(metric))} · ${date.format(first)} – ${date.format(last)}`}</title>
        {data.length > 1 && <polyline points={points.map((point) => point.join(',')).join(' ')} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
        {points.length <= 60 && points.map(([x, y], i) => <circle key={data[i].time} cx={x} cy={y} r="2.7" fill="currentColor"><title>{`${date.format(data[i].time)} · ${number.format(data[i].value)}`}</title></circle>)}
      </svg>
      <figcaption className="col-start-2 flex flex-wrap justify-between gap-x-2 pt-1 tabular-nums">
        <time dateTime={new Date(first).toISOString()}>{date.format(first)}</time>
        {first !== last && <time dateTime={new Date(last).toISOString()}>{date.format(last)}</time>}
      </figcaption>
    </figure>
  );
}

function SnapshotTable({ rows, milestones }: { rows: { snapshot: Snapshot | null; label: string }[]; milestones?: boolean }) {
  const t = useT();
  const language = useLanguage();
  const number = new Intl.NumberFormat(language);
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' });
  const caption = t(word(milestones ? 'milestones' : 'recent'));
  return (
    <div className="overflow-x-auto" role="region" aria-label={caption} tabIndex={0}>
      <table className="w-full border-collapse text-xs">
        <caption className="pb-1 text-left font-medium text-[var(--text)]">{caption}</caption>
        <thead className="text-[var(--text-muted)]">
          <tr>
            {milestones && <th scope="col" aria-label={caption} className={CELL} />}
            <th scope="col" className={`${CELL} text-left`}>{t(word('capturedAt'))}</th>
            {METRICS.map((metric) => <th scope="col" key={metric} className={`${CELL} text-right`}>{t(word(metric))}</th>)}
            {!milestones && <th scope="col" className={`${CELL} text-right`}>{t(word('source'))}</th>}
          </tr>
        </thead>
        <tbody>{rows.map(({ snapshot, label }) => (
          <tr key={label}>
            {milestones && <th scope="row" className={`${CELL} text-left`}>{label}</th>}
            <td className={`${CELL} text-left`}>{snapshot ? <time dateTime={new Date(snapshot.capturedAt).toISOString()}>{date.format(snapshot.capturedAt)}</time> : '—'}</td>
            {METRICS.map((metric) => <td key={metric} className={`${CELL} text-right`}>{snapshot?.[metric] == null ? '—' : number.format(snapshot[metric])}</td>)}
            {!milestones && snapshot && <td className={`${CELL} text-right`}>{sourceLabel(t, snapshot.source)}</td>}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function sourceLabel(t: ReturnType<typeof useT>, value: string) {
  return ['manual', 'csv', 'douyin', 'xiaohongshu'].includes(value) ? t(word(value)) : value;
}

export default function WorkbenchAnalytics({ video, onChange, refreshKey }: { video: Video; onChange?: () => void; refreshKey?: number }) {
  const t = useT();
  const path = `workbench/videos/${encodeURIComponent(video.id)}/snapshots`;
  const [series, setSeries] = useState<Series>();
  const [metric, setMetric] = useState<Metric>('views');
  const [platform, setPlatform] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [loadProblem, setLoadProblem] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoadProblem('');
    void studioCall<Series>(path, { signal: controller.signal }).then(
      (data) => { if (!controller.signal.aborted) setSeries(data); },
      (error) => { if (!controller.signal.aborted) setLoadProblem(message(error)); },
    );
    return () => controller.abort();
  }, [path, refreshKey, retry, video.platform, video.publishedAt]);

  async function submit(event: FormEvent<HTMLFormElement>, csv: boolean) {
    event.preventDefault();
    setProblem('');
    setNotice('');
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true);
    try {
      let body: unknown;
      if (csv) {
        const file = fields.get('csv');
        if (!(file instanceof File) || !file.size || file.size > 1_048_576) throw new Error(t(word('fileTooLarge')));
        body = { csv: await file.text(), platform: video.platform };
      } else {
        const capturedAt = new Date(String(fields.get('capturedAt'))).getTime();
        if (!Number.isFinite(capturedAt)) throw new Error(t(word('timeInvalid')));
        if (!METRICS.some((name) => fields.get(name))) throw new Error(t(word('metricsNeeded')));
        body = { ...Object.fromEntries(fields), capturedAt, platform: video.platform };
      }
      const data = await studioCall<Series & { added: number }>(path, { method: 'POST', json: body });
      setSeries(data);
      setRetry((value) => value + 1);
      setPlatform(video.platform ?? '');
      setNotice(data.added ? t(word('imported')).replace('{count}', String(data.added)) : t(word('unchanged')));
      form.reset();
      onChange?.();
    } catch (error) { setProblem(message(error)); }
    finally { setBusy(false); }
  }

  const platforms = [...new Set([video.platform ?? '', ...(series?.snapshots.map((snapshot) => snapshot.platform) ?? [])])].filter(Boolean);
  const selected = platforms.includes(platform) ? platform : platforms[0];
  const rows = series?.snapshots.filter((snapshot) => snapshot.platform === selected) ?? [];
  return (
    <section className="grid gap-3 border-t border-[var(--border)] pt-4" aria-label={t(word('title'))}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t(word('title'))}</h3>
        <div className="flex flex-wrap gap-2">
          {platforms.length > 1 && <label className={LABEL}>{t(word('platform'))}
            <select value={selected} onChange={(event) => setPlatform(event.target.value)} className={FIELD}>
              {platforms.map((name) => <option key={name} value={name}>{sourceLabel(t, name)}</option>)}
            </select>
          </label>}
          {rows.length > 0 && <label className={LABEL}>{t(word('metric'))}
            <select value={metric} onChange={(event) => setMetric(event.target.value as Metric)} className={FIELD}>
              {METRICS.map((name) => <option key={name} value={name}>{t(word(name))}</option>)}
            </select>
          </label>}
        </div>
      </div>
      {loadProblem && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-xs text-[var(--warn)]">{loadProblem}</p><button type="button" className={BUTTON} onClick={() => setRetry((value) => value + 1)}>{t(word('retry'))}</button></div>}
      {!loadProblem && !series && <p role="status" className="text-xs text-[var(--text-muted)]">{t(word('loading'))}</p>}
      {series && !rows.length && <p className="text-xs text-[var(--text-muted)]">{t(word('noData'))}</p>}
      {rows.length > 0 && <Trend rows={rows} metric={metric} />}
      {series && selected === video.platform && (video.publishedAt == null
        ? <p className="text-xs text-[var(--text-muted)]">{t(word('publishFirst'))}</p>
        : <div className="grid gap-1">
          <SnapshotTable milestones rows={series.milestones.map(({ days, snapshot }) => ({ label: `T+${days}`, snapshot }))} />
          <p className="text-xs text-[var(--text-muted)]">{t(word('milestoneHint'))}</p>
        </div>)}
      {rows.length > 0 && <SnapshotTable rows={rows.slice(-20).reverse().map((snapshot) => ({ label: String(snapshot.capturedAt), snapshot }))} />}
      {video.platform ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <details className="rounded-lg border border-[var(--border)] p-2.5">
            <summary className="cursor-pointer text-sm font-medium">{t(word('add'))}</summary>
            <form className="mt-2 grid gap-2" onSubmit={(event) => void submit(event, false)}>
              <label className={LABEL}>{t(word('capturedAt'))}<input className={FIELD} type="datetime-local" name="capturedAt" defaultValue={localDateTime()} required /></label>
              <div className="grid grid-cols-2 gap-2">{METRICS.map((name) => (
                <label key={name} className={LABEL}>{t(word(name))}<input className={FIELD} name={name} type="number" min={name === 'followersDelta' ? undefined : 0} step={1} /></label>
              ))}</div>
              <button type="submit" className={BUTTON} disabled={busy || !series}>{t(word(busy ? 'saving' : 'save'))}</button>
            </form>
          </details>
          <details className="rounded-lg border border-[var(--border)] p-2.5">
            <summary className="cursor-pointer text-sm font-medium">{t(word('upload'))}</summary>
            <form className="mt-2 grid gap-2" onSubmit={(event) => void submit(event, true)}>
              <p className="text-xs text-[var(--text-muted)]">{t(word('csvHelp'))}</p>
              <code className="break-all text-xs text-[var(--text-muted)]">capturedAt,{METRICS.join(',')}</code>
              <label className={LABEL}>{t(word('choose'))}<input className={FIELD} name="csv" type="file" accept=".csv,text/csv" required /></label>
              <button type="submit" className={BUTTON} disabled={busy || !series}>{t(word(busy ? 'saving' : 'upload'))}</button>
            </form>
          </details>
        </div>
      ) : <p className="text-xs text-[var(--text-muted)]">{t(word('platformNeeded'))}</p>}
      {problem && <p role="alert" className="text-xs text-[var(--warn)]">{problem}</p>}
      {notice && <p role="status" className="text-xs text-[var(--text-muted)]">{notice}</p>}
    </section>
  );
}

export function WorkbenchWeekly() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  async function download() {
    setBusy(true);
    setProblem('');
    try {
      const { markdown } = await studioCall<{ markdown: string }>('workbench/reports/weekly');
      const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `workbench-weekly-${localDateTime().slice(0, 10)}.md`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setProblem(message(error)); }
    finally { setBusy(false); }
  }
  return <div className="grid gap-1">
    <button type="button" className={BUTTON} onClick={() => void download()} disabled={busy}><Download size={14} aria-hidden />{t(word(busy ? 'downloading' : 'weekly'))}</button>
    {problem && <p role="alert" className="text-xs text-[var(--warn)]">{problem}</p>}
  </div>;
}
