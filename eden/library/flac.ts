import { closeSync, openSync, writeSync } from "node:fs";

const SAMPLE_RATE = 44_100;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const BLOCK_SIZE = 4096;
const VENDOR = "Aurral Eden";

const STREAMINFO = 0;
const PADDING = 1;
const VORBIS_COMMENT = 4;
const PICTURE = 6;
const FRONT_COVER = 3;
const MAX_BLOCK_BYTES = 0xff_ffff;
// Aurral refuses a lossless file under 48 kbit/s as too small to hold music of its
// length, so every file is padded up to a size a real one could have.
export const SILENT_FLAC_KBPS = 64;

const crcTable = (bits: 8 | 16, polynomial: number) => {
  const top = 1 << (bits - 1);
  const mask = bits === 8 ? 0xff : 0xffff;
  return Uint16Array.from({ length: 256 }, (_, byte) => {
    let crc = bits === 8 ? byte : byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & top ? ((crc << 1) ^ polynomial) & mask : (crc << 1) & mask;
    }
    return crc;
  });
};
const CRC8 = crcTable(8, 0x07);
const CRC16 = crcTable(16, 0x8005);

function crc8(data: Uint8Array) {
  let crc = 0;
  for (const byte of data) crc = CRC8[crc ^ byte] ?? 0;
  return crc;
}

function crc16(data: Uint8Array) {
  let crc = 0;
  for (const byte of data) crc = (((crc << 8) & 0xffff) ^ (CRC16[(crc >> 8) ^ byte] ?? 0)) & 0xffff;
  return crc;
}

function frameNumber(value: number) {
  if (value < 0x80) return [value];
  if (value < 0x800) return [0xc0 | (value >> 6), 0x80 | (value & 0x3f)];
  if (value < 0x1_0000) {
    return [0xe0 | (value >> 12), 0x80 | ((value >> 6) & 0x3f), 0x80 | (value & 0x3f)];
  }
  return [
    0xf0 | (value >> 18),
    0x80 | ((value >> 12) & 0x3f),
    0x80 | ((value >> 6) & 0x3f),
    0x80 | (value & 0x3f),
  ];
}

// One frame of digital silence: every channel is a constant subframe of zero.
function silentFrame(index: number, samples: number) {
  const fullBlock = samples === BLOCK_SIZE;
  const header = [
    0xff,
    0xf8,
    ((fullBlock ? 0b1100 : 0b0111) << 4) | 0b1001,
    ((CHANNELS - 1) << 4) | (0b100 << 1),
    ...frameNumber(index),
    ...(fullBlock ? [] : [(samples - 1) >> 8, (samples - 1) & 0xff]),
  ];
  header.push(crc8(Uint8Array.from(header)));
  const body = Uint8Array.from([...header, ...new Array<number>(CHANNELS * 3).fill(0)]);
  const frame = Buffer.alloc(body.length + 2);
  frame.set(body);
  frame.writeUInt16BE(crc16(body), body.length);
  return frame;
}

const fullFrames: Buffer[] = [];
const fullFrame = (index: number) => (fullFrames[index] ??= silentFrame(index, BLOCK_SIZE));

function blockHeader(type: number, length: number, last = false) {
  const header = Buffer.alloc(4);
  header.writeUInt8((last ? 0x80 : 0) | type, 0);
  header.writeUIntBE(length, 1, 3);
  return header;
}

const metadataBlock = (type: number, body: Buffer) =>
  Buffer.concat([blockHeader(type, body.length), body]);

function streamInfo(totalSamples: number) {
  const body = Buffer.alloc(34);
  body.writeUInt16BE(BLOCK_SIZE, 0);
  body.writeUInt16BE(BLOCK_SIZE, 2);
  const packed =
    (BigInt(SAMPLE_RATE) << 44n) |
    (BigInt(CHANNELS - 1) << 41n) |
    (BigInt(BITS_PER_SAMPLE - 1) << 36n) |
    BigInt(totalSamples);
  body.writeBigUInt64BE(packed, 10);
  return body;
}

const lengthPrefixed = (value: Buffer, write: "LE" | "BE") => {
  const length = Buffer.alloc(4);
  if (write === "LE") length.writeUInt32LE(value.length);
  else length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
};

function vorbisComment(tags: Record<string, string | readonly string[]>) {
  const comments = Object.entries(tags).flatMap(([key, value]) =>
    [value].flat().map((entry) => Buffer.from(`${key}=${entry}`, "utf8")),
  );
  const count = Buffer.alloc(4);
  count.writeUInt32LE(comments.length);
  return Buffer.concat([
    lengthPrefixed(Buffer.from(VENDOR, "utf8"), "LE"),
    count,
    ...comments.map((comment) => lengthPrefixed(comment, "LE")),
  ]);
}

export type CoverImage = { data: Buffer; mimeType: string; width: number; height: number };

function picture({ data, mimeType, width, height }: CoverImage) {
  const numbers = (...values: number[]) => {
    const buffer = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => buffer.writeUInt32BE(value, index * 4));
    return buffer;
  };
  return Buffer.concat([
    numbers(FRONT_COVER),
    lengthPrefixed(Buffer.from(mimeType, "ascii"), "BE"),
    numbers(0, width, height, 24, 0),
    lengthPrefixed(data, "BE"),
  ]);
}

// Digital silence of an exact length. The padding between the tags and the audio is
// never written, so on a file system with sparse files it takes no room on disk.
export function writeSilentFlac(
  file: string,
  {
    durationMs,
    tags,
    cover,
  }: {
    durationMs: number;
    tags: Record<string, string | readonly string[]>;
    cover?: CoverImage;
  },
) {
  const totalSamples = Math.max(1, Math.round((durationMs / 1000) * SAMPLE_RATE));
  const frames: Buffer[] = [];
  for (let index = 0; index * BLOCK_SIZE < totalSamples; index += 1) {
    const samples = Math.min(BLOCK_SIZE, totalSamples - index * BLOCK_SIZE);
    frames.push(samples === BLOCK_SIZE ? fullFrame(index) : silentFrame(index, samples));
  }
  const audio = Buffer.concat(frames);
  const start = Buffer.concat([
    Buffer.from("fLaC", "ascii"),
    metadataBlock(STREAMINFO, streamInfo(totalSamples)),
    metadataBlock(VORBIS_COMMENT, vorbisComment(tags)),
    ...(cover ? [metadataBlock(PICTURE, picture(cover))] : []),
  ]);
  const descriptor = openSync(file, "w");
  try {
    let position = writeSync(descriptor, start, 0, start.length, 0);
    let padding = Math.max(
      0,
      Math.ceil((durationMs * SILENT_FLAC_KBPS) / 8) - start.length - audio.length,
    );
    do {
      const length = Math.min(padding, MAX_BLOCK_BYTES);
      padding -= length;
      const header = blockHeader(PADDING, length, padding === 0);
      position += writeSync(descriptor, header, 0, header.length, position) + length;
    } while (padding > 0);
    writeSync(descriptor, audio, 0, audio.length, position);
  } finally {
    closeSync(descriptor);
  }
}
