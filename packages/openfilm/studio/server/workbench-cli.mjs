// @ts-check
import { UsageError } from '../../src/shared.mjs';
import { studioHome } from './projects.mjs';
import { listSnapshots, weeklyReport } from './workbench-analytics.mjs';
import { closeWorkbench, listVideos, openWorkbench } from './workbench-store.mjs';
import { createWorkbenchTrends } from './workbench-trends.mjs';

const lineText = (/** @type {string} */ text) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

/** @param {string[]} args @param {{json?: boolean}} options */
export async function workbenchCommand(args, options) {
  const [section = 'list', command, id] = args;
  const list = section === 'list' && args.length <= 1;
  const today = section === 'topics' && command === 'today' && args.length === 2;
  const stats = section === 'video' && command === 'stats' && id && args.length === 3;
  const weekly = section === 'report' && command === 'weekly' && args.length === 2;
  if (!list && !today && !stats && !weekly) throw new UsageError('use workbench --help to see the available commands');
  const db = await openWorkbench();
  if (!db) throw new Error('The video workbench needs a Node runtime with SQLite. Use Node 24.');
  const reply = (/** @type {unknown} */ value, /** @type {string[]} */ lines) => ({ ok: true, lines: options.json ? [JSON.stringify(value, null, 2)] : lines });
  try {
    if (list) {
      const videos = await listVideos(db);
      return reply({ videos }, videos.length ? videos.map((video) => `${video.id}\t${video.status}\t${lineText(video.title)}`) : ['No video projects.']);
    }
    if (today) {
      const digest = await createWorkbenchTrends({ getStore: openWorkbench, stateDir: studioHome() }).read();
      return reply(digest, digest.topics.length ? digest.topics.map((topic) => `${topic.id}\t${lineText(topic.title)}`) : ['No recommendations have been generated for today.']);
    }
    if (stats) {
      const video = (await listVideos(db)).find((video) => video.id === id);
      if (!video) throw new Error(`Video not found: ${lineText(id)}`);
      const result = await listSnapshots(db, video);
      const lines = [`${lineText(video.title)}  (${video.status})`];
      for (const snapshot of result.snapshots) {
        lines.push(`${new Date(snapshot.capturedAt).toISOString()}\t${snapshot.platform}\tviews ${snapshot.views ?? '—'}\tlikes ${snapshot.likes ?? '—'}\tcomments ${snapshot.comments ?? '—'}\tshares ${snapshot.shares ?? '—'}\tsaves ${snapshot.saves ?? '—'}\tfollowers Δ ${snapshot.followersDelta ?? '—'}`);
      }
      if (!result.snapshots.length) lines.push('No data snapshots.');
      return reply({ video, ...result }, lines);
    }
    const report = await weeklyReport(db);
    return reply(report, [report.markdown.trimEnd()]);
  } finally {
    await closeWorkbench();
  }
}
