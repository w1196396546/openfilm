// @ts-check
/**
 * The window's tabs: one per open project and one Workbench. This keeps their order and status; main.mjs gives each a page.
 * Reads no Electron module, so `node --test` can use it.
 *
 * With none open, the window shows the projects; a tab closed can be opened again, last
 * closed first. A project gone (deleted, its folder gone) takes its tabs with it at once, all of them together, and
 * none of them can be opened again (`closeProjects`). A project missing only its film.html is not gone (`projectGone`).
 */
import { randomUUID } from 'node:crypto';

/**
 * Whether the project `projectId` is gone, by Studio's list of projects (`/api/projects`): off the list (deleted), or
 * its folder missing. One whose folder is there but film.html is not stays: an agent at work in it may be writing the
 * film again (a tool that deletes the file, then adds it whole), and closing its tab would stop that agent for good.
 * @param {Array<{ id: string, missing?: boolean, missingReason?: string }>} projects @param {string} projectId
 */
export function projectGone(projects, projectId) {
  const found = projects.find((p) => p.id === projectId);
  return !found || (Boolean(found.missing) && found.missingReason !== 'film');
}

/**
 * @typedef {{ kind: 'project', projectId: string } | { kind: 'workbench', projectId: null, topicId?: string }} TabPage
 * @typedef {TabPage & { id: string, title: string, working: boolean, asking: boolean, exporting: number | null, shown: number }} Tab
 * @typedef {{ tabs: Array<{ kind?: string, projectId?: string | null, topicId?: string, title?: string }>, active: number }} SavedTabs
 */

const REOPEN_KEPT = 20;

/** @param {unknown} id */
const validTopic = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);

/** @param {unknown} url */
export function topicFromLink(url) {
  const prefix = 'openfilm://topic/';
  if (typeof url !== 'string' || !url.toLowerCase().startsWith(prefix)) return null;
  const id = url.slice(prefix.length);
  return validTopic(id) ? id : null;
}

/**
 * @param {{ saved?: SavedTabs | null, now?: () => number, newId?: () => string }} [opts]
 */
export function createTabs({ saved = null, now = Date.now, newId = randomUUID } = {}) {
  /** @type {Tab[]} */
  let tabs = [];
  /** @type {string | null} */
  let active = null;
  /** @type {Array<{ tab: Tab, at: number }>} */
  const closed = [];

  const make = (/** @type {TabPage} */ page, title = '') => ({ ...page, id: newId(), title, working: false, asking: false, exporting: null, shown: now() });
  const indexOf = (/** @type {string} */ id) => tabs.findIndex((t) => t.id === id);

  /* Keep the saved active tab even when duplicate or invalid entries before it are dropped. */
  if (saved && Array.isArray(saved.tabs)) {
    const at = Math.min(Math.max(0, Math.trunc(Number(saved.active) || 0)), saved.tabs.length - 1);
    const restored = saved.tabs.map((t) => {
      if (t?.kind === 'workbench') {
        const existing = tabs.find((tab) => tab.kind === 'workbench');
        if (existing) return existing;
        const tab = make({ kind: 'workbench', projectId: null, ...(validTopic(t.topicId) ? { topicId: t.topicId } : {}) });
        tabs.push(tab);
        return tab;
      }
      if ((t?.kind && t.kind !== 'project') || typeof t?.projectId !== 'string' || !t.projectId) return null;
      const existing = tabs.find((tab) => tab.projectId === t.projectId);
      if (existing) return existing;
      const tab = make({ kind: 'project', projectId: t.projectId }, typeof t.title === 'string' ? t.title : '');
      tabs.push(tab);
      return tab;
    });
    active = (restored[at] ?? tabs[Math.min(at, tabs.length - 1)])?.id ?? null;
  }

  const api = {
    /** The tabs in order, as the pages draw them. */
    list: () => tabs.map(({ id, kind, projectId, title, working, asking, exporting }) => ({ id, kind, projectId, title, active: id === active, working, asking, exporting })),
    activeId: () => active,
    /** @param {string} id */
    get: (id) => tabs.find((t) => t.id === id) ?? null,
    /** @param {string} projectId */
    byProject: (projectId) => tabs.find((t) => t.projectId === projectId) ?? null,
    /** @param {string} id @param {unknown} topicId */
    clearTopic(id, topicId) {
      const tab = api.get(id);
      if (tab?.kind !== 'workbench' || !tab.topicId || tab.topicId !== topicId) return false;
      delete tab.topicId;
      return true;
    },
    /**
     * A tab right of the one in front, or its existing tab brought forward.
     * @param {{ kind?: 'project', projectId: string, title?: string } | { kind: 'workbench', topicId?: string }} opts
     */
    open(opts) {
      const workbench = opts.kind === 'workbench';
      const there = workbench ? tabs.find((t) => t.kind === 'workbench') : api.byProject(opts.projectId);
      const topicId = workbench && validTopic(opts.topicId) ? opts.topicId : undefined;
      if (there) {
        if (there.kind === 'workbench' && topicId) there.topicId = topicId;
        api.activate(there.id);
        return there;
      }
      const tab = workbench ? make({ kind: 'workbench', projectId: null, ...(topicId ? { topicId } : {}) })
        : make({ kind: 'project', projectId: opts.projectId }, opts.title);
      const at = active ? indexOf(active) + 1 : tabs.length;
      tabs.splice(at, 0, tab);
      api.activate(tab.id);
      return tab;
    },
    /** @param {string} id */
    activate(id) {
      const tab = api.get(id);
      if (!tab) return false;
      active = id;
      tab.shown = now();
      return true;
    },
    /**
     * Close a tab: the one to its right comes to the front (else its left). → the tab in front now (null: none left)
     * @param {string} id
     */
    close(id) {
      const i = indexOf(id);
      if (i < 0) return api.get(active ?? '');
      const [gone] = tabs.splice(i, 1);
      closed.push({ tab: gone, at: i });
      if (closed.length > REOPEN_KEPT) closed.shift();
      if (!tabs.length) active = null;
      else if (active === id) api.activate(tabs[Math.min(i, tabs.length - 1)].id);
      return api.get(active ?? '');
    },
    /**
     * Projects gone: their tabs close together, without being kept to open again (nor any closed before), and the
     * front goes to the nearest tab that stays (right, else left). → { closed: the tabs closed, front: the tab in front
     * now (null: none left) }
     * @param {Iterable<string>} projectIds
     */
    closeProjects(projectIds) {
      const gone = new Set(projectIds);
      for (let i = closed.length - 1; i >= 0; i--) {
        const tab = closed[i].tab;
        if (tab.kind === 'project' && gone.has(tab.projectId)) closed.splice(i, 1);
      }
      const order = tabs.map((t) => t.id);
      const leaving = new Set(tabs.filter((t) => t.kind === 'project' && gone.has(t.projectId)).map((t) => t.id));
      if (!leaving.size) return { closed: [], front: api.get(active ?? '') };
      tabs = tabs.filter((t) => !leaving.has(t.id));
      if (!tabs.length) active = null;
      else if (active && leaving.has(active)) {
        const at = order.indexOf(active);
        const next = order.slice(at + 1).find((id) => !leaving.has(id)) ?? order.slice(0, at).reverse().find((id) => !leaving.has(id));
        active = null;
        if (next) api.activate(next);
      }
      return { closed: [...leaving], front: api.get(active ?? '') };
    },
    /** The tab closed last, open again where it was (its project in front if it is open already). → the tab, or null */
    reopen() {
      while (closed.length) {
        const last = closed.pop();
        if (!last) break;
        const there = last.tab.kind === 'workbench' ? tabs.find((t) => t.kind === 'workbench') : api.byProject(last.tab.projectId);
        if (there) { api.activate(there.id); return there; }
        const page = last.tab;
        const tab = page.kind === 'workbench'
          ? make({ kind: page.kind, projectId: null, ...(page.topicId ? { topicId: page.topicId } : {}) })
          : make({ kind: page.kind, projectId: page.projectId }, page.title);
        tabs.splice(Math.min(last.at, tabs.length), 0, tab);
        api.activate(tab.id);
        return tab;
      }
      return null;
    },
    /** @param {string} id @param {number} index */
    move(id, index) {
      const i = indexOf(id);
      if (i < 0) return false;
      const [tab] = tabs.splice(i, 1);
      tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, tab);
      return true;
    },
    /**
     * What a tab's page says it shows now: its project's title, an export's progress.
     * @param {string} id @param {{ title?: string, exporting?: number | null }} state → whether there was such a tab
     */
    report(id, { title, exporting }) {
      const tab = api.get(id);
      if (!tab || tab.kind !== 'project') return false;
      if (typeof title === 'string') tab.title = title;
      if (exporting !== undefined) tab.exporting = typeof exporting === 'number' ? Math.max(0, Math.min(1, exporting)) : null;
      return true;
    },
    /**
     * The projects an agent is working in, and those where one waits for an answer. → whether a tab changed
     * @param {Iterable<string>} working @param {Iterable<string>} [asking]
     */
    setAgents(working, asking = []) {
      const w = new Set(working); const a = new Set(asking);
      let changed = false;
      for (const t of tabs) {
        if (t.kind !== 'project') continue;
        const nw = w.has(t.projectId); const na = a.has(t.projectId);
        if (nw !== t.working || na !== t.asking) { t.working = nw; t.asking = na; changed = true; }
      }
      return changed;
    },
    /**
     * Tabs behind for `ms` or more whose pages may be let go (they come back when shown): none with an agent working
     * or an export running.
     * @param {number} ms
     */
    idle(ms) {
      const t0 = now();
      return tabs.filter((t) => t.id !== active && t0 - t.shown >= ms && !t.working && t.exporting == null).map((t) => t.id);
    },
    /** As kept for next time. @returns {SavedTabs} */
    saved: () => ({ tabs: tabs.map((t) => t.kind === 'workbench'
      ? { kind: t.kind, ...(t.topicId ? { topicId: t.topicId } : {}) }
      : { kind: t.kind, projectId: t.projectId, title: t.title }), active: Math.max(0, indexOf(active ?? '')) }),
  };
  return api;
}
