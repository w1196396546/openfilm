import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarDay, calendarEntries, calendarWeeks } from './workbench-calendar.ts';

test('the month grid spans full local weeks across month and year boundaries', () => {
  const weeks = calendarWeeks(new Date(2027, 0, 31));
  assert.equal(weeks.length, 5);
  assert.deepEqual(weeks[0].map((d) => d.getDate()), [28, 29, 30, 31, 1, 2, 3]);
  assert.equal(weeks[0][0].getFullYear(), 2026);
  assert.equal(weeks.at(-1)?.at(-1)?.getDate(), 31);
  assert.equal(calendarWeeks(new Date(2021, 1, 1)).length, 4);
  assert.equal(calendarWeeks(new Date(2026, 10, 1)).length, 6);
});

test('entries keep moved publication dates and show the actual time once on the same day', () => {
  const at = (day: number, hour: number) => +new Date(2026, 2, day, hour);
  const entries = calendarEntries([
    { id: 'a', title: 'A', scheduledAt: at(8, 10), publishedAt: at(9, 14) },
    { id: 'b', title: 'B', scheduledAt: at(8, 15), publishedAt: at(8, 9) },
    { id: 'c', title: 'C', scheduledAt: null, publishedAt: null },
  ]);
  assert.deepEqual(entries.get(calendarDay(at(8, 23)))?.map(({ id, at, kind }) => [id, new Date(at).getHours(), kind]), [
    ['b', 9, 'published'], ['a', 10, 'scheduled'],
  ]);
  assert.deepEqual(entries.get(calendarDay(at(9, 1))), [{ id: 'a', title: 'A', at: at(9, 14), kind: 'published' }]);
  assert.equal(entries.size, 2);
});
