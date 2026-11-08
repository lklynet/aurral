// Completed track NZBs are a bounded, source-backed cache, not a new download owner.
// All cache admission, attachment and removal use the same lock. No timer or DB schema.
import path from "node:path";
import { isDownloadOwnerProcess } from "./downloadJobs/downloadOwnerClient.ts";
import { logger } from "./logger.ts";
import { measureCompletedNzb, completedNzbFolderMissing } from "./completedNzbFiles.ts";
import { completedNzbStore } from "./completedNzbStore.ts";
import { sanitizeNzbName } from "./usenetClientCommon.ts";

type Id = string | number;
type History = { DestDir?: string; NZBID?: number; ID?: number; NZBName?: string; HistoryTime?: number; Status?: string | null };
type Entry = { removing?: boolean; destDir: string; signature: string; bytes: number; folder: string; guid: string; id: Id; title: string; time: number; expires: number };
export const COMPLETED_NZB_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_COMPLETED_NZBS = 50;
export const COMPLETED_NZB_BYTE_BUDGET = 250 * 1024 ** 3;

export class CompletedNzbReuse {
  private entries = new Map<string, Entry>();
  private tail: Promise<unknown> = Promise.resolve();
  private recovered = false;
  private readonly io: {
    consumers: (id: Id) => boolean;
    history: (id: Id) => Promise<History | null>;
    histories?: () => Promise<History[]>;
    hasFiles: (history: History) => Promise<boolean>;
    remove: (id: Id, history: History) => Promise<void>;
    now?: () => number;
    byteBudget?: number;
  };
  constructor(io: CompletedNzbReuse["io"]) { this.io = io; }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (!isDownloadOwnerProcess()) throw new Error("Completed NZB mutation requires download owner");
      return fn();
    });
    this.tail = result.catch(() => {});
    return result;
  }
  private now() { return this.io.now?.() ?? Date.now(); }
  private identity(id: Id, title: string, history: History | null): history is History {
    return Boolean(history && String(history.NZBID ?? history.ID) === String(id) &&
      history.NZBName === sanitizeNzbName(title) &&
      String(history.Status || "").toUpperCase().startsWith("SUCCESS/") &&
      Number.isFinite(history.HistoryTime) && Number(history.HistoryTime) > 0 &&
      Number(history.HistoryTime) * 1000 <= this.now());
  }
  private async read(entry: Entry, items?: History[]) {
    const history = items ? items.find(h => String(h.NZBID ?? h.ID) === String(entry.id)) ?? null : await this.io.history(entry.id);
    return this.identity(entry.id, entry.title, history) && history.HistoryTime === entry.time && history.DestDir === entry.destDir ? history : null;
  }
  // Call only inside run(). A read error aborts without discarding cleanup ownership.
  async retain(client: string, guid: string, id: Id, title: string): Promise<boolean> {
    if (client !== "nzbget" || !guid || !title) return false;
    this.load();
    const history = await this.io.history(id);
    if (!this.identity(id, title, history)) return false;
    const expires = Number(history.HistoryTime) * 1000 + COMPLETED_NZB_TTL_MS;
    if (expires <= this.now() || !await this.io.hasFiles(history)) return false;
    const budget = this.io.byteBudget ?? COMPLETED_NZB_BYTE_BUDGET;
    const material = await measureCompletedNzb(history, budget);
    if (!material || material.bytes > budget || material.freeBytes < 1024 ** 3 + material.bytes) return false;
    const old = this.entries.get(guid);
    if (old && (String(old.id) !== String(id) || old.time !== history.HistoryTime ||
      old.destDir !== history.DestDir || old.folder !== material.folder ||
      old.bytes !== material.bytes || old.signature !== material.signature || old.removing)) return false;
    const overBudget = () => [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) + (old ? 0 : material.bytes) > budget || (!old && this.entries.size >= MAX_COMPLETED_NZBS);
    while (overBudget()) {
      const victim = [...this.entries.values()].sort((a,b) => a.time - b.time).find(entry => entry.guid !== guid && !this.io.consumers(entry.id));
      if (!victim) return false;
      const before = this.entries.size;
      await this.evict(victim);
      if (this.entries.size === before) return false;
    }
    const next = new Map(this.entries);
    next.set(guid, { ...material, destDir: history.DestDir!, guid, id, title, time: Number(history.HistoryTime), expires });
    completedNzbStore.save([...next.values()]);
    this.entries = next;
    return true;
  }
  preserves(client: string, id: Id | null | undefined) {
    if (client !== "nzbget") return false;
    this.load();
    return client === "nzbget" && [...this.entries.values()].some(entry => String(entry.id) === String(id));
  }
  shouldCopy(client: string, id: Id | null | undefined) {
    if (client !== "nzbget") return false;
    // Reviews can read from the API process: refresh the durable owner, not its jobs.
    this.load(true);
    return this.preserves(client, id);
  }
  async attach(client: string, guid: string, title: string, attach: (id: Id) => void): Promise<Id | null> {
    if (client !== "nzbget") return null;
    await this.sweep();
    const entry = this.entries.get(guid);
    if (!entry || entry.title !== title) return null;
    if (entry.removing || entry.expires <= this.now()) throw new Error("Completed release unavailable: expired cleanup pending");
    const history = await this.read(entry);
    const material = history ? await measureCompletedNzb(history) : null;
    if (!history || !material || material.folder !== entry.folder || material.signature !== entry.signature || !await this.io.hasFiles(history)) {
      this.drop(guid);
      return null;
    }
    // I/O can cross the TTL boundary while the lock is held.
    if (entry.expires <= this.now()) return null;
    // Metadata is persisted before unlocking, so cleanup sees this new consumer.
    attach(entry.id);
    return entry.id;
  }
  private async evict(entry: Entry, items?: History[]) {
    if (this.io.consumers(entry.id)) return;
    const history = await this.read(entry, items);
    const material = history ? await measureCompletedNzb(history) : null;
    if (this.io.consumers(entry.id)) return;
    const retryMissing = history && entry.removing && await completedNzbFolderMissing(entry.folder);
    if (history && (retryMissing || (material?.signature === entry.signature && material.folder === entry.folder))) {
      const next = new Map(this.entries);
      next.set(entry.guid, { ...entry, removing: true });
      completedNzbStore.save([...next.values()]);
      this.entries = next;
      await this.io.remove(entry.id, history);
    }
    this.drop(entry.guid);
  }
  private drop(guid: string) {
    const next = new Map(this.entries);
    next.delete(guid);
    completedNzbStore.save([...next.values()]);
    this.entries = next;
  }
  load(force = false) {
    if (force || !this.recovered) {
      const entries = completedNzbStore.load() as Entry[];
      if (entries.length > MAX_COMPLETED_NZBS || new Set(entries.map(e => e?.guid)).size !== entries.length ||
        new Set(entries.map(e => String(e?.id))).size !== entries.length || entries.some(e => !e ||
        typeof e.guid !== "string" || !e.guid || typeof e.title !== "string" || !e.title ||
        !Number.isSafeInteger(Number(e.id)) || Number(e.id) <= 0 ||
        typeof e.destDir !== "string" || !e.destDir || typeof e.folder !== "string" || !path.isAbsolute(e.folder) ||
        !Number.isSafeInteger(e.bytes) || e.bytes < 0 || !/^[a-f0-9]{64}$/.test(e.signature) ||
        (e.removing !== undefined && typeof e.removing !== "boolean") ||
        !Number.isSafeInteger(e.time) || e.time <= 0 || e.expires !== e.time * 1000 + COMPLETED_NZB_TTL_MS))
        throw new Error("Completed NZB catalog unavailable: invalid identity");
      this.entries = new Map(entries.map(e => [e.guid, e]));
      this.recovered = true;
    }
  }
  async sweep() {
    this.load();
    const due = [...this.entries.values()].filter(e => e.expires <= this.now() && !this.io.consumers(e.id));
    if (!due.length) return;
    let items: History[] | undefined;
    try { items = this.io.histories ? await this.io.histories() : undefined; }
    catch (error) { logger.warn("usenet", "Completed cache maintenance history unavailable; ownership retained"); return; }
    for (const entry of due) {
      try { await this.evict(entry, items); }
      catch (error) { logger.warn("usenet", "Completed cache cleanup unavailable; ownership retained"); }
    }
  }
}
