import { isSpotifyExportFile, spotifyExportTally } from "../../../lib/spotifyExport.ts";
import { readZipEntries } from "./zipEntries.ts";

export async function readSpotifyExport(files: Iterable<File>, now = Date.now()) {
  const sources: { name: string; read: () => Promise<string> }[] = [];
  for (const file of files) {
    if (/\.zip$/i.test(file.name))
      sources.push(...(await readZipEntries(file, isSpotifyExportFile)));
    else if (isSpotifyExportFile(file.name))
      sources.push({ name: file.name, read: () => file.text() });
  }
  const tally = spotifyExportTally(now);
  for (const source of sources) {
    let data: unknown;
    try {
      data = JSON.parse(await source.read());
    } catch {
      throw new Error(`Couldn't read ${source.name.split("/").pop()}.`);
    }
    tally.add(source.name, data);
  }
  return tally.artists();
}
