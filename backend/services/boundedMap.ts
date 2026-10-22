export default class BoundedMap extends Map {
  constructor(maxEntries = 1000, entries) {
    super();
    const parsed = Math.floor(Number(maxEntries));
    this.maxEntries = Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
    if (entries) {
      for (const [key, value] of entries) this.set(key, value);
    }
  }

  set(key, value) {
    if (this.has(key)) this.delete(key);
    super.set(key, value);
    while (this.size > this.maxEntries) {
      this.delete(this.keys().next().value);
    }
    return this;
  }
}
