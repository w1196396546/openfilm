import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, studioCall } from '@/api';
import { useLanguage, useT } from '@/i18n';
import { CardButton } from '../Card';

type Platform = 'douyin' | 'xiaohongshu';
type Source = { platform: Platform; health: string; enabled: boolean; setupOpen: boolean; lastRunAt: number | null; attemptedToday: boolean };
type Response = { sources: Source[] };
type Action = 'open' | 'connect' | 'disable';
const endpoint = 'workbench/creator';

export default function WorkbenchCreator({ revision = 0 }: { revision?: number }) {
  const t = useT();
  const language = useLanguage();
  const titleId = useId();
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ platform: Platform; action: Action } | null>(null);
  const actionVersion = useRef(0);
  const time = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' });

  useEffect(() => {
    let live = true;
    const version = actionVersion.current;
    void studioCall<Response>(endpoint).then(
      ({ sources: next }) => {
        if (!live || version !== actionVersion.current) return;
        setSources(next);
        setError((previous) => previous === 'loadFailed' ? '' : previous);
      },
      () => { if (live && version === actionVersion.current) setError('loadFailed'); },
    );
    return () => { live = false; };
  }, [revision]);

  async function update(platform: Platform, action: Action) {
    const version = ++actionVersion.current;
    setPending({ platform, action });
    setError('');
    try {
      const response = await studioCall<Response>(`${endpoint}/${platform}/${action}`, { method: 'POST' });
      if (version === actionVersion.current) setSources(response.sources);
    } catch (cause) {
      if (version === actionVersion.current) {
        setError(cause instanceof ApiError && cause.body.code === 'onceDaily' ? 'onceDaily' : 'actionFailed');
      }
    } finally {
      if (version === actionVersion.current) setPending(null);
    }
  }

  return (
    <section aria-labelledby={titleId} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-panel)] p-4">
      <h2 id={titleId} className="text-sm font-semibold">{t('workbench.creator.title')}</h2>
      <p className="mt-2 text-[13px] text-[var(--text-muted)]">{t('workbench.creator.intro')}</p>
      <p className="mt-1 text-[13px] text-[var(--text-muted)]">{t('workbench.creator.limited')}</p>
      {error ? <p role="alert" className="mt-2 text-[13px] text-[var(--err)]">{t(`workbench.creator.${error}`)}</p> : null}
      {sources.map((source) => {
        const inFlight = pending?.platform === source.platform && pending.action !== 'disable';
        const canDisable = source.enabled || source.setupOpen || source.health === 'reading' || inFlight;
        return (
          <div key={source.platform} className="mt-3 border-t border-[var(--border)] pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-[13px] font-medium">{t(`workbench.platforms.${source.platform}`)}</h3>
                <p className="text-[13px] text-[var(--text-muted)]" role="status">
                  {t(`workbench.creator.status.${source.health}`)}
                  {source.lastRunAt ? <> · {t('workbench.creator.lastAttempt')} {time.format(source.lastRunAt)}</> : null}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {source.setupOpen ? (
                  <CardButton weight="primary" disabled={!!pending || source.attemptedToday} onClick={() => void update(source.platform, 'connect')}>
                    {t('workbench.creator.connect')}
                  </CardButton>
                ) : !source.enabled && source.health !== 'reading' ? (
                  <CardButton disabled={!!pending} onClick={() => void update(source.platform, 'open')}>
                    {t('workbench.creator.open')}
                  </CardButton>
                ) : null}
                {canDisable ? (
                  <CardButton disabled={pending?.action === 'disable'} onClick={() => void update(source.platform, 'disable')}>
                    {t('workbench.creator.disable')}
                  </CardButton>
                ) : null}
              </div>
            </div>
            {source.setupOpen ? (
              <p className="mt-2 text-[13px] text-[var(--text-muted)]">{t(source.attemptedToday ? 'workbench.creator.onceDaily' : 'workbench.creator.setupHint')}</p>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
