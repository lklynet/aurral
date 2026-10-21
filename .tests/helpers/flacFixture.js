import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const VORBIS_COMMENT = 4;
const FFMPEG_VORBIS_NAMES = {
  album_artist: "ALBUMARTIST",
  track: "TRACKNUMBER",
  disc: "DISCNUMBER",
  comment: "DESCRIPTION",
};
const encodedTones = new Map();
let fixturesWritten = 0;

function readFlacBlocks(data) {
  const blocks = [];
  let offset = 4;
  for (let last = false; !last;) {
    last = (data[offset] & 0x80) !== 0;
    const length = data.readUIntBE(offset + 1, 3);
    blocks.push({
      type: data[offset] & 0x7f,
      body: data.subarray(offset + 4, offset + 4 + length),
    });
    offset += 4 + length;
  }
  return { blocks, frames: data.subarray(offset) };
}

function encodeTone(seconds) {
  if (!encodedTones.has(seconds)) {
    encodedTones.set(
      seconds,
      (async () => {
        const folder = await mkdtemp(path.join(tmpdir(), "aurral-flac-fixture-"));
        const filePath = path.join(folder, "tone.flac");
        try {
          await execFileAsync("ffmpeg", [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            `sine=frequency=440:duration=${seconds}`,
            filePath,
          ]);
          return readFlacBlocks(await readFile(filePath));
        } finally {
          await rm(folder, { recursive: true, force: true });
        }
      })(),
    );
  }
  return encodedTones.get(seconds);
}

function vorbisComment(vendor, comments) {
  const field = (text) => {
    const bytes = Buffer.from(text, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return [length, bytes];
  };
  const count = Buffer.alloc(4);
  count.writeUInt32LE(comments.length);
  return Buffer.concat([...field(vendor), count, ...comments.flatMap(field)]);
}

export async function writeFlacFixture(filePath, tags = {}, { seconds = 0.2 } = {}) {
  const { blocks, frames } = await encodeTone(seconds);
  const comments = Object.entries(tags)
    .filter(([, value]) => `${value}` !== "")
    .map(([key, value]) => `${FFMPEG_VORBIS_NAMES[key] ?? key}=${value}`);
  const uniqueVendor = `Aurral test fixture ${(fixturesWritten += 1)}`;
  const tagged = blocks.map((block) =>
    block.type === VORBIS_COMMENT
      ? { ...block, body: vorbisComment(uniqueVendor, comments) }
      : block,
  );
  const encoded = tagged.flatMap(({ type, body }, index) => {
    const header = Buffer.alloc(4);
    header[0] = type | (index === tagged.length - 1 ? 0x80 : 0);
    header.writeUIntBE(body.length, 1, 3);
    return [header, body];
  });
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.concat([Buffer.from("fLaC"), ...encoded, frames]));
  return filePath;
}
