export const discSubtitle = (metadata: Record<string, unknown> | null | undefined) => {
  const tags = metadata?.tags;
  const [subtitle] = [
    tags && typeof tags === "object" && "discsubtitle" in tags ? tags.discsubtitle : null,
  ].flat();
  return typeof subtitle === "string" ? subtitle.trim() : "";
};

export function discTitles(tracks: Iterable<{ disc: number; title: string | null | undefined }>) {
  const seen = new Map<number, Set<string>>();
  for (const { disc, title } of tracks) {
    if (title) seen.set(disc, (seen.get(disc) ?? new Set()).add(title));
  }
  const titles = new Map<number, string>();
  for (const [disc, names] of seen) {
    const [title] = names;
    if (title && names.size === 1) titles.set(disc, title);
  }
  return titles;
}
