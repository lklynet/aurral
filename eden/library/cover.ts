import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import type { CoverImage } from "./flac.ts";

const SIZE = 600;
const BANDS = 6;

function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const framed = Buffer.alloc(body.length + 8);
  framed.writeUInt32BE(data.length, 0);
  body.copy(framed, 4);
  framed.writeUInt32BE(crc32(body), body.length + 4);
  return framed;
}

// A cover that differs for every seed, so albums are easy to tell apart in the app.
export function generatedCover(seed: string): CoverImage {
  const hash = createHash("sha256").update(seed).digest();
  const colors = Array.from({ length: BANDS }, (_, band) => [
    hash[band * 3] ?? 0,
    hash[band * 3 + 1] ?? 0,
    hash[band * 3 + 2] ?? 0,
  ]);
  const diagonal = ((hash[20] ?? 0) % 3) - 1;
  const row = Buffer.alloc(1 + SIZE * 3);
  const rows: Buffer[] = [];
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const position = (((x + diagonal * y) % SIZE) + SIZE) % SIZE;
      const [red, green, blue] = colors[Math.floor((position * BANDS) / SIZE)] ?? [0, 0, 0];
      row.set([red ?? 0, green ?? 0, blue ?? 0], 1 + x * 3);
    }
    rows.push(Buffer.from(row));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return {
    data: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]),
    mimeType: "image/png",
    width: SIZE,
    height: SIZE,
  };
}
