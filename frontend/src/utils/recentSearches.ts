const STORAGE_KEY = "aurral:recent-searches";
const MAX_RECENT = 8;

function normalizeQuery(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

export function readRecentSearches() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    const items = [];
    for (const entry of parsed) {
      const query = normalizeQuery(entry);
      if (!query) continue;
      const key = query.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(query);
      if (items.length >= MAX_RECENT) break;
    }
    return items;
  } catch {
    return [];
  }
}

export function addRecentSearch(query) {
  const normalized = normalizeQuery(query);
  if (!normalized) return readRecentSearches();
  const next = [
    normalized,
    ...readRecentSearches().filter((entry) => entry.toLowerCase() !== normalized.toLowerCase()),
  ].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

export function clearRecentSearches() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
  return [];
}
