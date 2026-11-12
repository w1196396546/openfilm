export const PRODUCTION_STATUSES = ['idea', 'script', 'storyboard', 'production', 'review', 'ready', 'scheduled', 'published', 'analyzing'] as const;

export type ProductionStatus = typeof PRODUCTION_STATUSES[number];

export type Video = {
  id: string;
  projectId: string;
  projectPath: string;
  title: string;
  missing: boolean;
  status: ProductionStatus;
  accountId: string;
  platform: string | null;
  videoUrl: string | null;
  scheduledAt: number | null;
  publishedAt: number | null;
  durationS: number | null;
  tags: string[];
  hook: string | null;
  cover?: number;
  hasPoster: boolean;
  createdAt: number;
  recentViews: number | null;
  latestSnapshot: { capturedAt: number; views: number | null } | null;
};

export type VideoPatch = Partial<Pick<Video, 'status' | 'platform' | 'videoUrl' | 'scheduledAt' | 'publishedAt' | 'tags' | 'hook'>>;

export function dateTimeInput(ms: number | null) {
  if (ms == null) return '';
  const date = new Date(ms);
  return new Date(ms - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function productionPatch(video: Video, fields: FormData): VideoPatch {
  const patch: VideoPatch = {};
  for (const key of ['platform', 'videoUrl', 'hook'] as const) {
    const value = String(fields.get(key) ?? '').trim() || null;
    if (value !== video[key]) patch[key] = value;
  }
  for (const key of ['scheduledAt', 'publishedAt'] as const) {
    const value = String(fields.get(key) ?? '');
    if (value !== dateTimeInput(video[key])) patch[key] = value ? new Date(value).getTime() : null;
  }
  const status = fields.get('status');
  if (typeof status === 'string' && PRODUCTION_STATUSES.some((value) => value === status) && status !== video.status) {
    patch.status = status as ProductionStatus;
  }
  const enteredTags = String(fields.get('tags') ?? '');
  if (enteredTags !== video.tags.join(', ')) {
    const tags = [...new Set(enteredTags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))];
    if (tags.length !== video.tags.length || tags.some((tag, index) => tag !== video.tags[index])) patch.tags = tags;
  }
  return patch;
}
