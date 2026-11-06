const MIN_SHELF_ITEMS = 3;
const SHELF_ITEMS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

export type FeedGroup<T> = { label: string; items: T[] };

export function splitFeed<T>(
  items: readonly T[],
  groupOf: (item: T) => string,
  isLead: (item: T) => boolean = () => true,
) {
  const leadIndex = Math.max(0, items.findIndex(isLead));
  const rest = items.filter((_, index) => index !== leadIndex);
  const shelf = rest.length >= MIN_SHELF_ITEMS ? rest.slice(0, SHELF_ITEMS) : [];
  const groups: FeedGroup<T>[] = [];
  for (const item of rest.slice(shelf.length)) {
    const label = groupOf(item);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return { lead: items[leadIndex], shelf, groups };
}

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

export function newsDayLabel(publishedAt: string, now = new Date()) {
  const published = new Date(publishedAt);
  if (Number.isNaN(published.getTime())) return "Earlier";
  const days = Math.round((startOfDay(now) - startOfDay(published)) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  return "Earlier";
}
