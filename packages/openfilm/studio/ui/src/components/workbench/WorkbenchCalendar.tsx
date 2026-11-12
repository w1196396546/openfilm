import { useId, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLanguage, useT } from '@/i18n';
import type { Video } from '@/lib/workbench';
import { calendarDay, calendarEntries, calendarWeeks } from '@/lib/workbench-calendar';
import { CardButton } from '../Card';

export function WorkbenchCalendar({ videos, onSelect }: { videos: Video[]; onSelect: (id: string) => void }) {
  const t = useT();
  const language = useLanguage();
  const heading = useId();
  const [month, setMonth] = useState(() => new Date());
  const weeks = calendarWeeks(month);
  const entries = useMemo(() => calendarEntries(videos), [videos]);
  const format = useMemo(() => ({
    month: new Intl.DateTimeFormat(language, { year: 'numeric', month: 'long' }),
    weekday: new Intl.DateTimeFormat(language, { weekday: 'short' }),
    date: new Intl.DateTimeFormat(language, { dateStyle: 'full' }),
    time: new Intl.DateTimeFormat(language, { timeStyle: 'short' }),
  }), [language]);
  const today = calendarDay(Date.now());
  const move = (by: number) => setMonth((current) => new Date(current.getFullYear(), current.getMonth() + by, 1));

  return (
    <section className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-panel)]" aria-labelledby={heading}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <h2 id={heading} aria-live="polite" className="text-sm font-semibold">{format.month.format(month)}</h2>
        <div className="flex items-center gap-1.5">
          <CardButton onClick={() => setMonth(new Date())}>{t('workbench.calendar.today')}</CardButton>
          <CardButton onClick={() => move(-1)} className="w-7 px-0" aria-label={t('workbench.calendar.previous')} title={t('workbench.calendar.previous')}>
            <ChevronLeft size={15} />
          </CardButton>
          <CardButton onClick={() => move(1)} className="w-7 px-0" aria-label={t('workbench.calendar.next')} title={t('workbench.calendar.next')}>
            <ChevronRight size={15} />
          </CardButton>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table aria-labelledby={heading} className="w-full min-w-[44rem] table-fixed border-collapse text-left">
          <thead>
            <tr className="border-y border-[var(--border)] bg-[var(--bg-field)] text-xs text-[var(--text-muted)]">
              {weeks[0].map((day) => <th key={+day} scope="col" className="px-3 py-2 font-medium">{format.weekday.format(day)}</th>)}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={+week[0]}>
                {week.map((day) => {
                  const isToday = +day === today;
                  const outside = day.getMonth() !== month.getMonth();
                  const date = format.date.format(day);
                  return (
                    <td key={+day} className={`h-24 border-b border-r border-[var(--border)] p-1.5 align-top last:border-r-0 ${outside ? 'bg-[var(--bg-field)]' : ''}`}>
                      <span aria-current={isToday ? 'date' : undefined}
                        className={`mb-1 inline-flex h-6 min-w-6 items-center justify-center rounded-full text-xs tabular-nums ${isToday ? 'bg-[var(--primary)] font-semibold text-[var(--on-primary)]' : outside ? 'text-[var(--text-muted)]' : ''}`}>
                        <span aria-hidden="true">{day.getDate()}</span>
                        <span className="sr-only">{date}</span>
                      </span>
                      <div className="space-y-1">
                        {entries.get(+day)?.map(({ id, title, at, kind }) => {
                          const when = `${t(`workbench.calendar.${kind}`)} · ${format.time.format(at)}`;
                          const description = `${title} · ${date} · ${when}`;
                          return (
                            <button type="button" key={id} data-workbench-video={id} onClick={() => onSelect(id)} title={description} aria-label={description}
                              className="block w-full min-w-0 rounded-md border-l-2 bg-[var(--bg-raised)] px-1.5 py-1 text-left hover:bg-[var(--bg-hover)]"
                              style={{ borderLeftColor: kind === 'published' ? 'var(--ok)' : 'var(--accent)' }}>
                              <span className="block truncate text-xs font-medium">{title}</span>
                              <span className="block truncate text-[11px] text-[var(--text-muted)]">{when}</span>
                            </button>
                          );
                        })}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
