import "../../backend/services/libraryWatchProcessChild.ts";

setTimeout(() => {
  throw Object.assign(new Error("Stale file handle"), { code: "ESTALE" });
});
