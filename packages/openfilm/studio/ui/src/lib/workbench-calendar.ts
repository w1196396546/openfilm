import type { Video } from './workbench.ts';

type CalendarVideo = Pick<Video, 'id' | 'title' | 'scheduledAt' | 'publishedAt'>;

type CalendarEntry = { id: string; title: string; at: number; kind: 'scheduled' | 'published' };

export const calendarDay = (at: number) => new Date(at).setHours(0, 0, 0, 0);

/** Build full Monday–Sunday weeks using local calendar dates across daylight saving changes. */
export function calendarWeeks(month: Date): Date[][] {
  const year = month.getFullYear();
  const index = month.getMonth();
  const offset = (new Date(year, index, 1).getDay() + 6) % 7;
  const days = new Date(year, index + 1, 0).getDate();
  return Array.from({ length: Math.ceil((offset + days) / 7) }, (_, week) => (
    Array.from({ length: 7 }, (_, day) => new Date(year, index, week * 7 + day + 1 - offset))
  ));
}

export function calendarEntries(videos: readonly CalendarVideo[]): Map<number, CalendarEntry[]> {
  const byDay = new Map<number, CalendarEntry[]>();
  for (const { id, title, scheduledAt, publishedAt } of videos) {
    const add = (at: number, kind: CalendarEntry['kind']) => {
      const day = calendarDay(at);
      const entry = { id, title, at, kind };
      const entries = byDay.get(day);
      if (entries) entries.push(entry);
      else byDay.set(day, [entry]);
    };
    if (scheduledAt !== null && (publishedAt === null || calendarDay(scheduledAt) !== calendarDay(publishedAt))) {
      add(scheduledAt, 'scheduled');
    }
    if (publishedAt !== null) add(publishedAt, 'published');
  }
  for (const entries of byDay.values()) entries.sort((a, b) => a.at - b.at);
  return byDay;
}
