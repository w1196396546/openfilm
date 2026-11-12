import { useEffect, useRef, useState, type FormEvent, type Ref } from 'react';
import { ArrowUpRight, Plus, RefreshCw, Settings2 } from 'lucide-react';
import { ApiError, studioCall } from '@/api';
import { Card, CardButton } from '@/components/Card';
import { SettingsField, SettingsSwitch } from '@/components/settings/ui';
import { useLanguage, useT } from '@/i18n';
import { workbenchLink } from '@/lib/workbench-links';

type SourceId = 'douyin' | 'baidu';
type SourceStatus = 'fresh' | 'stale' | 'unavailable' | 'disabled';
type ChartItem = { title: string; url: string | null; heat: number | null; rank: number };
type Source = { id: SourceId; status: SourceStatus; updatedAt: string | null; fetchedAt: string | null; items: ChartItem[] };
type Topic = {
  id: string; title: string; source?: string; url?: string | null; heat?: number | null;
  reason?: string | null; format?: string | null; status?: 'new' | 'saved' | 'started'; projectId?: string | null;
};
type Channel = 'feishu' | 'wecom';
type Deliveries = Record<Channel, { status: 'pending' | 'sent' | 'failed' } | null>;
type Today = { date: string; generatedAt: string | null; sources: Source[]; topics: Topic[]; deliveries: Deliveries };
type Reference = { id: string; topicId: string | null; platform: string; url: string; title: string; author?: string | null; breakdown: string | null };
type Delivery = {
  sources: Record<SourceId, boolean>;
  webhooks: Record<Channel, { configured: boolean; last4: string | null; fromEnv: boolean }>;
};
type BrowseProps = { revision: number; onOpenProject: (projectId: string) => void };

const todayPath = 'workbench/today';
const topicsPath = 'workbench/topics';
const referencesPath = 'workbench/references';
const settingsPath = `${todayPath}/settings`;
const topicPath = (id: string) => `${topicsPath}/${encodeURIComponent(id)}`;
const inputStyle = 'rounded-lg border border-[var(--border)] bg-[var(--bg-field)] p-2 text-[13px] outline-none focus:border-[var(--text-muted)]';
const quietText = 'text-[13px] text-[var(--text-muted)]';
const errorText = 'break-words text-[13px] text-[var(--err)]';
const linkStyle = 'inline-flex max-w-full items-center gap-1 underline-offset-2 hover:underline';
const sourceIds = ['douyin', 'baidu'] as const;
const channels = ['feishu', 'wecom'] as const;
const referencePlatforms = ['douyin', 'xiaohongshu', 'other'] as const;

function useTodayT() {
  const t = useT();
  return (key: string) => t(`workbench.today.${key}`);
}

function useTopicLibrary(revision: number) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [references, setReferences] = useState<Reference[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.allSettled([
      studioCall<{ topics: Topic[] }>(topicsPath),
      studioCall<{ references: Reference[] }>(referencesPath),
    ]).then(([topicResult, referenceResult]) => {
      if (!live) return;
      if (topicResult.status === 'fulfilled') setTopics(topicResult.value.topics);
      if (referenceResult.status === 'fulfilled') setReferences(referenceResult.value.references);
      const failed = [topicResult, referenceResult].find((result) => result.status === 'rejected');
      setError(failed ? String(failed.reason instanceof Error ? failed.reason.message : failed.reason) : '');
      setLoaded(true);
    });
    return () => { live = false; };
  }, [revision]);
  return {
    topics, references, error, loaded,
    updateTopic: (topic: Topic) => setTopics((before) => [topic, ...before.filter(({ id }) => id !== topic.id)]),
    addReference: (reference: Reference) => setReferences((before) => [reference, ...before.filter(({ id }) => id !== reference.id)]),
  };
}

type Library = ReturnType<typeof useTopicLibrary>;

export function WorkbenchToday({ topicId, revision, onOpenProject }: BrowseProps & { topicId?: string }) {
  const t = useTodayT();
  const language = useLanguage();
  const library = useTopicLibrary(revision);
  const [today, setToday] = useState<Today | null>(null);
  const [deepTopic, setDeepTopic] = useState<Topic | null>(null);
  const [missingTopic, setMissingTopic] = useState('');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [referenceSaved, setReferenceSaved] = useState(false);
  const focused = useRef<HTMLElement>(null);

  useEffect(() => {
    let live = true;
    void studioCall<Today>(todayPath).then((brief) => {
      if (!live) return;
      setToday(brief);
      setError('');
    }, (cause) => { if (live) setError(cause.message); });
    return () => { live = false; };
  }, [revision]);

  useEffect(() => {
    if (!topicId) return;
    let live = true;
    void studioCall<{ topic: Topic }>(topicPath(topicId)).then(({ topic }) => {
      if (live) setDeepTopic(topic);
    }, (cause) => {
      if (!live) return;
      if (cause instanceof ApiError && cause.status === 404) setMissingTopic(topicId);
      else setError(String((cause as Error).message));
    });
    return () => { live = false; };
  }, [topicId]);

  const recommendations = today?.topics ?? [];
  const selected = recommendations.find(({ id }) => id === topicId)
    ?? library.topics.find(({ id }) => id === topicId)
    ?? (deepTopic?.id === topicId ? deepTopic : undefined);
  const selectedId = selected?.id;
  useEffect(() => {
    if (!selectedId || !focused.current) return;
    focused.current.focus({ preventScroll: true });
    focused.current.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  async function refresh() {
    setError('');
    setRefreshing(true);
    try { setToday(await studioCall<Today>(`${todayPath}/refresh`, { method: 'POST' })); }
    catch (cause) { setError(String((cause as Error).message)); }
    finally { setRefreshing(false); }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {today?.date ? <time dateTime={today.date} className="text-[14px] font-medium">{today.date}</time> : null}
          {today?.generatedAt ? (
            <span className={quietText}>{t('updatedAt').replace('{time}', new Date(today.generatedAt).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' }))}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CardButton onClick={() => setSettingsOpen(!settingsOpen)} aria-expanded={settingsOpen}><Settings2 size={14} />{t('settings')}</CardButton>
          <CardButton onClick={() => { setReferenceOpen(!referenceOpen); setReferenceSaved(false); }} aria-expanded={referenceOpen}><Plus size={14} />{t('addReference')}</CardButton>
          <CardButton weight="primary" disabled={refreshing} onClick={() => { void refresh(); }}>
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : undefined} />{t(refreshing ? 'refreshing' : 'refresh')}
          </CardButton>
        </div>
      </div>
      {error || library.error ? <p role="alert" className={errorText}>{error || library.error}</p> : null}
      {!today && !error ? <p role="status" className={quietText}>{t('loading')}</p> : null}
      {settingsOpen ? <DeliverySettings deliveries={today?.deliveries} revision={revision} /> : null}
      {referenceOpen ? <ReferenceForm onClose={() => setReferenceOpen(false)} onSave={(reference) => { library.addReference(reference); setReferenceSaved(true); }} /> : null}
      {referenceSaved ? <p role="status" className={quietText}>{t('referenceSaved')}</p> : null}
      {today && !today.generatedAt ? <p className={quietText}>{t('noBrief')}</p> : null}
      {!selected && missingTopic && missingTopic === topicId ? <p role="status" className={quietText}>{t('topicMissing')}</p> : null}
      <div className="grid items-start gap-5 min-[900px]:grid-cols-[minmax(0,1.65fr)_minmax(260px,1fr)]">
        <section className="min-w-0 space-y-2.5" aria-label={t('recommendations')}>
          <h2 className="text-[15px] font-semibold">{t('recommendations')}</h2>
          {(selected ? [selected, ...recommendations.filter(({ id }) => id !== selectedId)] : recommendations).map((topic) => (
            <TopicCard key={topic.id} topic={topic} library={library} onOpenProject={onOpenProject} focused={topic.id === selectedId ? focused : undefined} />
          ))}
          {today?.generatedAt && !recommendations.length ? <p className={quietText}>{t('noRecommendations')}</p> : null}
        </section>
        <section className="min-w-0 space-y-2.5" aria-label={t('charts')}>
          <h2 className="text-[15px] font-semibold">{t('charts')}</h2>
          {today?.sources.map((source) => <SourceChart key={source.id} source={source} />)}
        </section>
      </div>
    </div>
  );
}

function SourceChart({ source }: { source: Source }) {
  const t = useTodayT();
  const language = useLanguage();
  const number = new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 });
  const tone = source.status === 'fresh' ? 'bg-[var(--ok)]' : 'bg-[var(--text-faint)]';
  const stamp = source.updatedAt ?? source.fetchedAt;
  return (
    <Card title={<span className="flex items-center justify-between gap-2">{t(`source.${source.id}`)}
      <span className="inline-flex items-center gap-1.5 text-[11px] font-normal text-[var(--text-muted)]">
        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${tone}`} />{t(`health.${source.status}`)}
      </span>
    </span>}>
      {source.items.length ? (
        <ol className={`mt-2 divide-y divide-[var(--border)] ${source.status !== 'fresh' ? 'text-[var(--text-faint)]' : ''}`}>
          {source.items.slice(0, 10).map((item) => {
            const link = workbenchLink(item.url);
            return (
              <li key={`${item.rank}-${item.title}`} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-1.5 py-1.5 text-[12px]">
                <span className="text-right tabular-nums text-[var(--text-muted)]">{item.rank}</span>
                {link ? <a href={link} target="_blank" rel="noreferrer" className="break-words underline-offset-2 hover:underline">{item.title}</a> : <span className="break-words">{item.title}</span>}
                {item.heat != null ? <span className="tabular-nums text-[var(--text-muted)]" title={t('heat').replace('{heat}', String(item.heat))}>{number.format(item.heat)}</span> : null}
              </li>
            );
          })}
        </ol>
      ) : <p className={`mt-2 ${quietText}`}>{t('chartEmpty')}</p>}
      {stamp ? <p className={`mt-1 ${quietText}`}>
        {t(source.updatedAt ? 'sourceUpdated' : 'sourceFetched').replace('{time}', new Date(stamp).toLocaleString(language, { dateStyle: 'short', timeStyle: 'short' }))}
      </p> : null}
    </Card>
  );
}

function TopicCard({ topic, library, onOpenProject, focused }: {
  topic: Topic; library: Library; onOpenProject: BrowseProps['onOpenProject']; focused?: Ref<HTMLElement>;
}) {
  const t = useTodayT();
  const language = useLanguage();
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [action, setAction] = useState<'save' | 'start' | null>(null);
  const [error, setError] = useState('');
  const saved = library.topics.find(({ id }) => id === topic.id);
  const status = saved?.status ?? topic.status;
  const references = library.references.filter((reference) => reference.topicId === topic.id);
  const trendLink = workbenchLink(topic.url);

  async function save() {
    setError('');
    setAction('save');
    try {
      const { topic: updated } = await studioCall<{ topic: Topic }>(topicPath(topic.id), { method: 'PATCH', json: { status: 'saved' } });
      library.updateTopic(updated);
    } catch (cause) { setError(String((cause as Error).message)); }
    finally { setAction(null); }
  }

  async function start() {
    setError('');
    setAction('start');
    try {
      const { video } = await studioCall<{ video: { projectId: string } }>(`${topicPath(topic.id)}/start`, { method: 'POST' });
      library.updateTopic({ ...topic, ...saved, status: 'started', projectId: video.projectId });
      onOpenProject(video.projectId);
    } catch (cause) { setError(String((cause as Error).message)); }
    finally { setAction(null); }
  }

  return (
    <article ref={focused} tabIndex={focused ? -1 : undefined} className={`rounded-xl ${focused ? 'ring-2 ring-[var(--primary)]' : ''}`}>
      <Card title={<span className="break-words text-[14px]">{topic.title}</span>}>
        {topic.source === 'douyin' || topic.source === 'baidu' || topic.heat != null || trendLink ? (
          <div className="mt-1.5 flex flex-wrap gap-2 text-[12px] text-[var(--text-muted)]">
            {topic.source === 'douyin' || topic.source === 'baidu' ? <span>{t(`source.${topic.source}`)}</span> : null}
            {topic.heat != null ? <span>{t('heat').replace('{heat}', new Intl.NumberFormat(language, { notation: 'compact' }).format(topic.heat))}</span> : null}
            {trendLink ? <a href={trendLink} target="_blank" rel="noreferrer" className={linkStyle}>{t('chartLink')} <ArrowUpRight size={12} aria-hidden="true" /></a> : null}
          </div>
        ) : null}
        {topic.reason || topic.format ? (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-words text-[12.5px]">
            {topic.reason ? <><dt className="font-medium">{t('reason')}</dt><dd className="min-w-0 text-[var(--text-muted)]">{topic.reason}</dd></> : null}
            {topic.format ? <><dt className="font-medium">{t('format')}</dt><dd className="min-w-0 text-[var(--text-muted)]">{topic.format}</dd></> : null}
          </dl>
        ) : null}
        <div className="mt-3 border-t border-[var(--border)] pt-2.5">
          {references.length ? <ReferenceList references={references} /> : <p className={quietText}>{t('referenceEmpty')}</p>}
        </div>
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
          <CardButton weight="quiet" onClick={() => setReferenceOpen(!referenceOpen)} aria-expanded={referenceOpen}><Plus size={14} />{t('addReference')}</CardButton>
          <div className="flex flex-wrap items-center gap-2">
            {status === 'started' || status === 'saved' ? <span className={quietText}>{t(status)}</span> : null}
            {status === 'new' || !status ? <CardButton onClick={() => { void save(); }} disabled={!!action}>{t(action === 'save' ? 'saving' : 'saveTopic')}</CardButton> : null}
            <CardButton weight="primary" onClick={() => { void start(); }} disabled={!!action}>{t(action === 'start' ? 'starting' : status === 'started' ? 'openProject' : 'start')}</CardButton>
          </div>
        </div>
        {error ? <p role="alert" className={`mt-2 ${errorText}`}>{error}</p> : null}
        {referenceOpen ? <ReferenceForm topicId={topic.id} onClose={() => setReferenceOpen(false)} onSave={library.addReference} /> : null}
      </Card>
    </article>
  );
}

function ReferenceList({ references }: { references: Reference[] }) {
  const t = useTodayT();
  return (
    <ul aria-label={t('reference')} className="space-y-1 text-[12.5px] text-[var(--text-muted)]">
      {references.map((reference) => {
        const url = workbenchLink(reference.url);
        const title = reference.title || reference.url;
        return (
          <li key={reference.id} className="min-w-0 break-words">
            {url ? <a href={url} target="_blank" rel="noreferrer" className={linkStyle}><span className="min-w-0 break-words">{title}</span><ArrowUpRight className="shrink-0" size={12} aria-hidden="true" /></a> : <span>{title}</span>}
            {reference.author ? <span className="ml-2">{reference.author}</span> : null}
            {reference.breakdown ? <p className="mt-0.5 whitespace-pre-wrap text-[var(--text-faint)]">{reference.breakdown}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

function ReferenceForm({ topicId, onSave, onClose }: { topicId?: string; onSave: (reference: Reference) => void; onClose: () => void }) {
  const t = useTodayT();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const url = workbenchLink(String(fields.get('url') ?? ''));
    if (!url) { setError(t('badReferenceUrl')); return; }
    setSaving(true);
    setError('');
    try {
      const { reference } = await studioCall<{ reference: Reference }>(referencesPath, {
        method: 'POST', json: { topicId, platform: fields.get('platform'), title: fields.get('title'), url, breakdown: fields.get('breakdown') },
      });
      onSave(reference);
      onClose();
    } catch (cause) { setError(String((cause as Error).message)); }
    finally { setSaving(false); }
  }
  return (
    <form onSubmit={(event) => { void submit(event); }} className="mt-3 space-y-2 rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] p-3 text-[12px]">
      <div className="grid gap-2 min-[520px]:grid-cols-[minmax(0,1fr)_auto]">
        <label className="grid min-w-0 gap-1">{t('referenceTitle')}<SettingsField name="title" required maxLength={240} autoFocus /></label>
        <label className="grid gap-1">{t('referencePlatform')}
          <select className={inputStyle} name="platform">
            {referencePlatforms.map((platform) => <option key={platform} value={platform}>{t(platform === 'douyin' ? 'source.douyin' : platform)}</option>)}
          </select>
        </label>
      </div>
      <label className="grid gap-1">{t('referenceUrl')}<SettingsField name="url" type="url" required maxLength={2048} placeholder="https://…" /></label>
      <label className="grid gap-1">{t('referenceBreakdown')}<textarea name="breakdown" className={inputStyle} rows={3} maxLength={20000} /></label>
      {error ? <p role="alert" className={errorText}>{error}</p> : null}
      <div className="flex justify-end gap-2">
        <CardButton onClick={onClose} disabled={saving}>{t('cancel')}</CardButton>
        <CardButton type="submit" weight="primary" disabled={saving}>{t(saving ? 'saving' : 'save')}</CardButton>
      </div>
    </form>
  );
}

export function WorkbenchTopicLibrary({ revision, onOpenProject }: BrowseProps) {
  const t = useTodayT();
  const library = useTopicLibrary(revision);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const saved = library.topics.filter(({ status }) => status === 'saved' || status === 'started');
  const references = library.references.filter(({ topicId }) => !topicId);
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setError('');
    setSaving(true);
    try {
      const { topic } = await studioCall<{ topic: Topic }>(topicsPath, { method: 'POST', json: { title: new FormData(form).get('title') } });
      library.updateTopic(topic);
      form.reset();
    } catch (cause) { setError(String((cause as Error).message)); }
    finally { setSaving(false); }
  }
  return (
    <section aria-label={t('library')} className="space-y-3">
      <h2 className="text-[15px] font-semibold">{t('library')}</h2>
      <form onSubmit={(event) => { void add(event); }} className="flex items-center gap-2">
        <SettingsField name="title" required maxLength={240} aria-label={t('topicTitle')} placeholder={t('topicTitle')} />
        <CardButton type="submit" weight="primary" disabled={saving}><Plus size={14} />{t(saving ? 'saving' : 'addTopic')}</CardButton>
      </form>
      {error || library.error ? <p role="alert" className={errorText}>{error || library.error}</p> : null}
      {library.loaded && !saved.length ? <p className={quietText}>{t('noSaved')}</p> : null}
      {saved.map((topic) => <TopicCard key={topic.id} topic={topic} library={library} onOpenProject={onOpenProject} />)}
      <Card title={t('standaloneReference')}>
        <div className="mt-2">{references.length ? <ReferenceList references={references} /> : <p className={quietText}>{t('standaloneReferenceEmpty')}</p>}</div>
        <CardButton weight="quiet" className="mt-2" onClick={() => setReferenceOpen(!referenceOpen)} aria-expanded={referenceOpen}><Plus size={14} />{t('addReference')}</CardButton>
        {referenceOpen ? <ReferenceForm onClose={() => setReferenceOpen(false)} onSave={library.addReference} /> : null}
      </Card>
    </section>
  );
}

function DeliverySettings({ deliveries, revision }: { deliveries?: Deliveries; revision: number }) {
  const t = useTodayT();
  const [settings, setSettings] = useState<Delivery | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'settingsUnavailable' | 'settingsError' | null>(null);
  useEffect(() => {
    let live = true;
    void studioCall<Delivery>(settingsPath).then((value) => { if (live) setSettings(value); }, () => { if (live) setError('settingsUnavailable'); });
    return () => { live = false; };
  }, [revision]);

  async function patch(patch: { sources?: Partial<Record<SourceId, boolean>>; webhooks?: Partial<Record<Channel, string | null>> }) {
    setBusy(true);
    setError(null);
    try {
      setSettings(await studioCall<Delivery>(settingsPath, { method: 'PATCH', json: patch }));
      return true;
    } catch { setError('settingsError'); return false; }
    finally { setBusy(false); }
  }

  async function saveWebhook(event: FormEvent<HTMLFormElement>, channel: Channel) {
    event.preventDefault();
    const form = event.currentTarget;
    const address = String(new FormData(form).get('url') ?? '').trim();
    if (address && await patch({ webhooks: { [channel]: address } })) form.reset();
  }

  return (
    <Card title={t('settings')}>
      {error ? <p role="alert" className={`mt-2 ${errorText}`}>{t(error)}</p> : null}
      {!settings && !error ? <p role="status" className={`mt-2 ${quietText}`}>{t('loading')}</p> : null}
      {settings ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-4">
            {sourceIds.map((source) => (
              <div key={source} className="flex items-center gap-2 text-[13px]">
                <span>{t(`source.${source}`)}</span>
                <SettingsSwitch label={t(`source.${source}`)} checked={settings.sources[source]} disabled={busy} onChange={(value) => { void patch({ sources: { [source]: value } }); }} />
              </div>
            ))}
          </div>
          <div className="space-y-2 border-t border-[var(--border)] pt-2">
            <h3 className="text-[13px] font-medium">{t('notification')}</h3>
            <p className={quietText}>{t('notificationHint')}</p>
            {channels.map((channel) => {
              const hook = settings.webhooks[channel];
              const delivery = deliveries?.[channel];
              return (
                <form key={channel} onSubmit={(event) => { void saveWebhook(event, channel); }} className="flex flex-wrap items-center gap-2">
                  <span className="w-20 shrink-0 text-[13px]">{t(channel)}</span>
                  <span className={`min-w-24 ${quietText}`}>{hook.configured ? `••••${hook.last4 ?? ''}` : t('noWebhook')}{hook.fromEnv ? ` · ${t('fromEnvironment')}` : ''}</span>
                  {delivery ? <span className={delivery.status === 'failed' ? errorText : quietText}>{t(`delivery.${delivery.status}`)}</span> : null}
                  {!hook.fromEnv ? (
                    <>
                      <SettingsField name="url" className="h-8 min-w-32 flex-1" type="password" autoComplete="off" spellCheck={false} required disabled={busy} aria-label={`${t(channel)} ${t('webhook')}`} placeholder={t('webhook')} />
                      <CardButton type="submit" disabled={busy}>{t('save')}</CardButton>
                      {hook.configured ? <CardButton onClick={() => { void patch({ webhooks: { [channel]: null } }); }} disabled={busy}>{t('remove')}</CardButton> : null}
                    </>
                  ) : null}
                </form>
              );
            })}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
