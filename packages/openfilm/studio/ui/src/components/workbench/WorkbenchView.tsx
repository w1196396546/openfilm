import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, Clapperboard, Eye, Kanban, LibraryBig, List, Radar, RefreshCw, Settings2 } from 'lucide-react';
import { studioCall } from '@/api';
import { useLanguage, useT } from '@/i18n';
import { formatDuration } from '@/lib/export-jobs';
import { studioHost } from '@/lib/host';
import { PRODUCTION_STATUSES, type ProductionStatus, type Video, type VideoPatch } from '@/lib/workbench';
import { CardButton } from '../Card';
import { WorkbenchChrome } from '../Launcher';
import { posterUrl } from '../ProjectCover';
import { ProjectsPopover } from '../ProjectsLibrary';
import { PosterMedia } from '../ProjectsView';
import { WorkbenchWeekly } from './WorkbenchAnalytics';
import { WorkbenchCalendar } from './WorkbenchCalendar';
import WorkbenchCreator from './WorkbenchCreator';
import { PLATFORMS, WorkbenchDetails } from './WorkbenchDetails';
import { WorkbenchHooks } from './WorkbenchReview';
import { WorkbenchToday, WorkbenchTopicLibrary } from './WorkbenchToday';

const SECTIONS = { production: Clapperboard, todayLabel: Radar, library: LibraryBig, sources: Settings2 };
const VIEWS = { board: Kanban, list: List, calendarLabel: CalendarDays };
const STATUS_COLOR: Record<ProductionStatus, string> = {
  idea: 'var(--text-faint)',
  script: 'var(--clip-page)',
  storyboard: 'var(--clip-image)',
  production: 'var(--clip-video)',
  review: 'var(--clip-text)',
  ready: 'var(--clip-audio)',
  scheduled: 'var(--accent)',
  published: 'var(--ok)',
  analyzing: 'var(--clip-effect)',
};

type Section = keyof typeof SECTIONS;
type View = keyof typeof VIEWS;

const errorText = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

export default function WorkbenchView({ onOpenProject, topicId, onClearTopic, revision }: {
  onOpenProject: (projectId: string) => void;
  topicId?: string;
  onClearTopic: () => void;
  revision: number;
}) {
  const t = useT();
  const [section, setSection] = useState<Section>(topicId ? 'todayLabel' : 'production');
  const [view, setView] = useState<View>('board');
  const [projects, setProjects] = useState(false);
  const [videos, setVideos] = useState<Video[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reading = useRef<AbortController | null>(null);
  const writing = useRef(false);

  const refresh = useCallback(() => {
    reading.current?.abort();
    const request = new AbortController();
    reading.current = request;
    void studioCall<{ videos: Video[] }>('workbench/videos', { signal: request.signal }).then((result) => {
      if (request.signal.aborted) return;
      setVideos(result.videos);
      setError('');
    }, (cause: unknown) => {
      if (!request.signal.aborted) setError(errorText(cause, t('workbench.loadFailed')));
    });
  }, [t]);

  useEffect(() => {
    refresh();
    return () => reading.current?.abort();
  }, [refresh, revision]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);
  useEffect(() => {
    if (topicId) setSection('todayLabel');
    else setSection((current) => current === 'todayLabel' ? 'production' : current);
  }, [topicId]);

  async function save(id: string, patch: VideoPatch) {
    if (writing.current) throw new Error(t('workbench.saving'));
    writing.current = true;
    setBusy(true);
    try {
      const { video } = await studioCall<{ video: Video }>(`workbench/videos/${encodeURIComponent(id)}`, { method: 'PATCH', json: patch });
      setVideos((current) => current?.map((item) => item.id === video.id ? video : item) ?? null);
      refresh();
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }

  const selected = videos?.find((video) => video.id === selectedId);

  function show(next: Section) {
    setSection(next);
    if (topicId && next !== 'todayLabel') onClearTopic();
  }

  return (
    <div className="workspace-shell flex flex-col bg-[var(--bg-panel)] text-[var(--text)]">
      {studioHost?.tabs ? (
        <><WorkbenchChrome onOpen={onOpenProject} projects={projects} onProjects={setProjects} /><div aria-hidden className="h-8 shrink-0" /></>
      ) : <ProjectsPopover open={projects} currentProjectId="" onOpen={onOpenProject} onCurrentRemoved={() => {}} onClose={() => setProjects(false)} />}
      <header className="shrink-0 border-b border-[var(--border)] bg-[var(--bg-raised)] px-4 sm:px-7">
        <div className="flex items-center justify-between gap-4 py-4">
          <h1 className="text-[24px] font-semibold tracking-tight">{t('workbench.title')}</h1>
          {!studioHost?.tabs ? <CardButton onClick={() => setProjects(true)}>{t('nav.projects')}</CardButton> : null}
        </div>
        <nav aria-label={t('workbench.title')} className="flex gap-3 overflow-x-auto sm:gap-6">
          {(Object.keys(SECTIONS) as Section[]).map((name) => {
            const Icon = SECTIONS[name];
            return (
              <button
                key={name}
                type="button"
                aria-current={section === name ? 'page' : undefined}
                onClick={() => show(name)}
                className={`inline-flex shrink-0 items-center gap-1.5 border-b-2 px-1 pb-2.5 text-[13px] font-medium ${section === name ? 'border-[var(--accent)] text-[var(--text)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'}`}
              >
                <Icon aria-hidden size={15} />{t(`workbench.${name}`)}
              </button>
            );
          })}
        </nav>
      </header>

      {section === 'production' ? (
        <main className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-7">
            <div role="group" aria-label={t('workbench.production')} className="inline-flex rounded-lg bg-[var(--bg-field)] p-0.5">
              {(Object.keys(VIEWS) as View[]).map((name) => {
                const Icon = VIEWS[name];
                return (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={view === name}
                    data-workbench-view={name}
                    onClick={() => setView(name)}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium ${view === name ? 'bg-[var(--bg-raised)] text-[var(--text)] shadow-[var(--shadow-sm)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}
                  >
                    <Icon aria-hidden size={14} />{t(`workbench.${name}`)}
                  </button>
                );
              })}
            </div>
            <CardButton onClick={refresh} disabled={busy}><RefreshCw aria-hidden size={13} />{t('workbench.refresh')}</CardButton>
          </div>
          {error ? <p role="alert" className="mx-4 mb-3 rounded-lg bg-[var(--bg-field)] px-3 py-2 text-[13px] text-[var(--err)] sm:mx-7">{error}</p> : null}
          {!videos ? (
            error ? null : <p role="status" className="mx-4 my-5 text-[13px] text-[var(--text-muted)] sm:mx-7">{t('workbench.loading')}</p>
          ) : !videos.length ? (
            <div className="mx-4 my-4 flex min-h-52 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--border-strong)] sm:mx-7">
              <Clapperboard aria-hidden size={24} className="text-[var(--text-faint)]" />
              <p className="text-[14px] font-medium">{t('workbench.empty')}</p>
              <CardButton onClick={() => setProjects(true)}>{t('workbench.goToProjects')}</CardButton>
            </div>
          ) : view === 'board' ? (
            <ProductionBoard
              videos={videos}
              onSelect={setSelectedId}
              busy={busy}
              onMove={(id, status) => void save(id, { status }).catch((cause: unknown) => setError(errorText(cause, t('workbench.saveFailed'))))}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 sm:px-7">
              {view === 'list' ? <ProductionList videos={videos} onSelect={setSelectedId} /> : <WorkbenchCalendar videos={videos} onSelect={setSelectedId} />}
            </div>
          )}
        </main>
      ) : (
        <main className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto grid w-full max-w-7xl items-start gap-6 p-4 sm:p-7">
            {section === 'todayLabel' ? <WorkbenchToday topicId={topicId} revision={revision} onOpenProject={onOpenProject} /> : null}
            {section === 'library' ? <><WorkbenchTopicLibrary revision={revision} onOpenProject={onOpenProject} /><WorkbenchHooks revision={revision} /><WorkbenchWeekly /></> : null}
            {section === 'sources' ? <WorkbenchCreator revision={revision} /> : null}
          </div>
        </main>
      )}
      {selected ? (
        <WorkbenchDetails
          key={selected.id}
          video={selected}
          onClose={() => setSelectedId(null)}
          onSave={(patch) => save(selected.id, patch)}
          onOpenProject={onOpenProject}
          onChange={refresh}
          revision={revision}
        />
      ) : null}
    </div>
  );
}

function ProductionBoard({ videos, busy, onSelect, onMove }: {
  videos: Video[];
  busy: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, status: ProductionStatus) => void;
}) {
  const t = useT();
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<ProductionStatus | null>(null);

  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 sm:px-7" data-workbench-board>
      <div className="flex min-h-full min-w-max gap-3">
        {PRODUCTION_STATUSES.map((status) => {
          const items = videos.filter((video) => video.status === status);
          return (
            <section
              key={status}
              data-status={status}
              aria-labelledby={`workbench-column-${status}`}
              className={`flex w-[218px] shrink-0 flex-col rounded-xl border transition-colors ${target === status ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)] bg-[var(--bg-field)]'}`}
              onDragOver={(event) => {
                if (busy || !dragging) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setTarget(status);
              }}
              onDragLeave={(event) => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                  setTarget((current) => current === status ? null : current);
                }
              }}
              onDrop={(event) => {
                if (busy || !dragging) return;
                event.preventDefault();
                if (!items.some((video) => video.id === dragging)) onMove(dragging, status);
                setDragging(null);
                setTarget(null);
              }}
            >
              <header className="flex h-11 shrink-0 items-center gap-2 px-3">
                <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: STATUS_COLOR[status] }} />
                <h2 id={`workbench-column-${status}`} className="min-w-0 flex-1 truncate text-[13px] font-semibold">{t(`workbench.statuses.${status}`)}</h2>
                <span className="text-[12px] tabular-nums text-[var(--text-muted)]">{items.length}</span>
              </header>
              <ul className="space-y-2.5 px-2 pb-2.5">
                {items.map((video) => (
                  <li key={video.id}>
                    <button
                      type="button"
                      data-workbench-video={video.id}
                      draggable={!busy && !video.missing}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('application/x-openfilm-workbench', video.id);
                        setDragging(video.id);
                      }}
                      onDragEnd={() => { setDragging(null); setTarget(null); }}
                      onClick={() => onSelect(video.id)}
                      className="group block w-full overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] text-left shadow-[var(--shadow-sm)] hover:border-[var(--border-strong)]"
                    >
                      <VideoCover video={video} />
                      <span className="grid gap-1.5 px-2.5 pb-2.5 pt-2">
                        <span className="truncate text-[13px] font-semibold group-hover:text-[var(--accent)]" title={video.title}>{video.title}</span>
                        <span className="flex flex-wrap items-center justify-between gap-1 text-[11.5px] text-[var(--text-muted)]">
                          <span><Platform id={video.platform} /></span><VideoDate video={video} />
                        </span>
                        {video.recentViews != null ? <RecentViews video={video} /> : null}
                        {video.missing ? <span className="text-[11.5px] text-[var(--warn)]">{t('workbench.missing')}</span> : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ProductionList({ videos, onSelect }: { videos: Video[]; onSelect: (id: string) => void }) {
  const t = useT();
  return (
    <div className="overflow-auto rounded-xl border border-[var(--border)] bg-[var(--bg-raised)]">
      <table className="w-full min-w-[620px] border-collapse text-left text-[13px]">
        <thead className="border-b border-[var(--border)] bg-[var(--bg-field)] text-[12px] text-[var(--text-muted)]">
          <tr>
            {(['project', 'status', 'platform', 'publishDate', 'recent'] as const).map((name) => (
              <th key={name} scope="col" className="px-3 py-2.5 font-medium">{t(`workbench.${name}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {videos.map((video) => (
            <tr key={video.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-hover)]">
              <td className="px-3 py-2">
                <button type="button" data-workbench-video={video.id} onClick={() => onSelect(video.id)} className="flex min-w-0 items-center gap-2.5 rounded-md text-left hover:text-[var(--accent)]">
                  <VideoCover video={video} compact />
                  <span className="min-w-0 max-w-[34ch]">
                    <span className="block truncate font-medium" title={video.title}>{video.title}</span>
                    {video.missing ? <span className="block text-[11px] text-[var(--warn)]">{t('workbench.missing')}</span> : null}
                  </span>
                </button>
              </td>
              <td className="whitespace-nowrap px-3 py-2"><span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: STATUS_COLOR[video.status] }} />{t(`workbench.statuses.${video.status}`)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-[var(--text-muted)]"><Platform id={video.platform} /></td>
              <td className="whitespace-nowrap px-3 py-2 text-[var(--text-muted)]"><VideoDate video={video} /></td>
              <td className="whitespace-nowrap px-3 py-2"><RecentViews video={video} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Platform({ id }: { id: string | null }) {
  const t = useT();
  if (!id) return t('workbench.unassigned');
  return PLATFORMS.some((platform) => platform === id) ? t(`workbench.platforms.${id}`) : id;
}

function VideoDate({ video }: { video: Video }) {
  const locale = useLanguage();
  const t = useT();
  const ms = video.publishedAt ?? video.scheduledAt;
  if (ms == null) return <span>—</span>;
  const date = new Date(ms);
  return (
    <time dateTime={date.toISOString()} title={`${t(video.publishedAt == null ? 'workbench.scheduledAt' : 'workbench.publishedAt')} · ${date.toLocaleString(locale)}`}>
      {date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
    </time>
  );
}

function RecentViews({ video }: { video: Video }) {
  const locale = useLanguage();
  const t = useT();
  if (video.recentViews == null) return <span className="text-[var(--text-muted)]">—</span>;
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] tabular-nums text-[var(--text-muted)]">
      <Eye size={13} aria-hidden />{t('workbench.views7d').replace('{n}', video.recentViews.toLocaleString(locale))}
    </span>
  );
}

function VideoCover({ video, compact = false }: { video: Video; compact?: boolean }) {
  const project = { id: video.projectId, poster: video.hasPoster ? posterUrl({ id: video.projectId, cover: video.cover }) : undefined };
  return (
    <span className={`relative flex items-center justify-center overflow-hidden bg-[var(--bg-field)] text-[var(--text-faint)] ${compact ? 'h-9 w-16 shrink-0 rounded-md' : 'aspect-video w-full'}`}>
      <PosterMedia project={project} shade={!compact && video.durationS != null} />
      {!compact && video.durationS != null ? (
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/65 px-1 py-0.5 font-mono text-[10px] leading-none text-white">{formatDuration(video.durationS * 1000)}</span>
      ) : null}
    </span>
  );
}
