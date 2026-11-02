const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;

export class ZipReadError extends Error {}

const view = async (blob: Blob, start: number, length: number) => {
  const bytes = await blob.slice(start, start + length).arrayBuffer();
  if (bytes.byteLength !== length) throw new ZipReadError("The zip file is truncated.");
  return new DataView(bytes);
};

export async function readZipEntries(blob: Blob, include: (name: string) => boolean) {
  const tailSize = Math.min(blob.size, 22 + MAX16);
  const tail = await view(blob, blob.size - tailSize, tailSize);
  let end = -1;
  for (let at = tailSize - 22; at >= 0 && end < 0; at -= 1) {
    if (tail.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) end = at;
  }
  if (end < 0) throw new ZipReadError("This file isn't a zip file.");
  const count = tail.getUint16(end + 10, true);
  const centralSize = tail.getUint32(end + 12, true);
  const centralOffset = tail.getUint32(end + 16, true);
  if (count === MAX16 || centralOffset === MAX32)
    throw new ZipReadError("This zip file is too large to read.");

  const central = await view(blob, centralOffset, centralSize);
  const decoder = new TextDecoder();
  const entries: { name: string; read: () => Promise<string> }[] = [];
  for (let index = 0, at = 0; index < count; index += 1) {
    if (central.getUint32(at, true) !== CENTRAL_FILE_HEADER)
      throw new ZipReadError("The zip file is damaged.");
    const method = central.getUint16(at + 10, true);
    const compressedSize = central.getUint32(at + 20, true);
    const nameLength = central.getUint16(at + 28, true);
    const localOffset = central.getUint32(at + 42, true);
    const name = decoder.decode(new Uint8Array(central.buffer, at + 46, nameLength));
    at += 46 + nameLength + central.getUint16(at + 30, true) + central.getUint16(at + 32, true);
    if (!include(name)) continue;
    if (method !== 0 && method !== 8) throw new ZipReadError(`Can't read ${name} from this zip.`);
    entries.push({
      name,
      read: async () => {
        const local = await view(blob, localOffset, 30);
        if (local.getUint32(0, true) !== LOCAL_FILE_HEADER)
          throw new ZipReadError("The zip file is damaged.");
        const start = localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
        const data = blob.slice(start, start + compressedSize);
        if (method === 0) return data.text();
        return new Response(
          data.stream().pipeThrough(new DecompressionStream("deflate-raw")),
        ).text();
      },
    });
  }
  return entries;
}
