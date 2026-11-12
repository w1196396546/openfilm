/** Links shown in the workbench come from feeds and user-entered references. */
export function workbenchLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
