// @ts-check
import { HttpError, json, readJson } from './http.mjs';
import { studioHome } from './projects.mjs';
import { openWorkbench, listVideos, patchVideo } from './workbench-store.mjs';
import { addSnapshots, listSnapshots, weeklyReport } from './workbench-analytics.mjs';
import { addReference, addTopic, getTopic, listReferences, listTopics, startTopic, updateTopic } from './workbench-topics.mjs';
import { createWorkbenchTrends } from './workbench-trends.mjs';
import { createWorkbenchCreator } from './workbench-creator.mjs';
import { generateReview, listHooks, listReview, saveHook, saveVariant } from './workbench-review.mjs';

/** @param {{changed: () => void, origin: () => string}} options */
export function createWorkbench({ changed, origin }) {
  const trends = createWorkbenchTrends({
    getStore: openWorkbench, stateDir: studioHome(), onChange: changed,
    workbenchUrl: () => `${origin()}/workbench`,
  });
  const creator = createWorkbenchCreator({ changed });

  return {
    start() {
      trends.start();
      creator.start();
    },
    async close() {
      await Promise.all([trends.stop(), creator.close()]);
    },
    /** @param {import('./http.mjs').Req} req @param {import('./http.mjs').Res} res @param {string[]} parts */
    async route(req, res, parts) {
      const db = await openWorkbench();
      if (!db) throw new HttpError(503, 'The video workbench needs a Node runtime with SQLite. Use Node 24.', { code: 'workbench-sqlite' });
      const [section, id, action] = parts;
      const method = req.method;
      const send = (/** @type {unknown} */ body) => json(res, 200, body);
      const wrote = (/** @type {unknown} */ body) => { changed(); send(body); };
      const body = () => readJson(req);
      if (section === 'creator') return creator.route(req, res, parts.slice(1), db);
      if (section === 'videos') {
        if (parts.length === 1 && method === 'GET') return send({ videos: await listVideos(db) });
        if (parts.length === 2 && method === 'PATCH') return wrote({ video: await patchVideo(db, id, await body()) });
        if (parts.length === 3 && ['snapshots', 'review', 'variants'].includes(action)) {
          const video = (await listVideos(db)).find((video) => video.id === id);
          if (!video) throw new HttpError(404, 'Video not found.');
          if (action === 'snapshots' && method === 'GET') return send(await listSnapshots(db, video));
          if (action === 'snapshots' && method === 'POST') return wrote(await addSnapshots(db, video, await body()));
          if (action === 'review' && method === 'GET') return send(await listReview(db, video));
          if (action === 'review' && method === 'POST') return wrote(await generateReview(db, video, await body()));
          if (action === 'variants' && method === 'POST') return wrote(await saveVariant(db, video, await body()));
        }
      }
      if (section === 'today') {
        if (parts.length === 1 && method === 'GET') return send(await trends.read());
        if (parts.length === 2 && id === 'refresh' && method === 'POST') return send(await trends.refresh());
        if (parts.length === 2 && id === 'settings' && method === 'GET') return send(await trends.settings());
        if (parts.length === 2 && id === 'settings' && method === 'PATCH') return send(await trends.updateSettings(await body()));
      }
      if (section === 'topics') {
        if (parts.length === 1 && method === 'GET') return send(listTopics(db));
        if (parts.length === 1 && method === 'POST') return wrote(addTopic(db, await body()));
        if (parts.length === 2 && method === 'GET') return send({ topic: getTopic(db, id) });
        if (parts.length === 2 && method === 'PATCH') return wrote(updateTopic(db, id, await body()));
        if (parts.length === 3 && action === 'start' && method === 'POST') return wrote(await startTopic(db, id));
      }
      if (section === 'references' && parts.length === 1) {
        if (method === 'GET') return send(listReferences(db));
        if (method === 'POST') return wrote(addReference(db, await body()));
      }
      if (section === 'hooks' && parts.length === 1) {
        if (method === 'GET') return send(await listHooks(db));
        if (method === 'POST') return wrote(await saveHook(db, await body()));
      }
      if (section === 'reports' && parts.length === 2 && id === 'weekly' && method === 'GET') return send(await weeklyReport(db));
      throw new HttpError(404, 'No such workbench API.');
    },
  };
}
