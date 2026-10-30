import { createReadStream, createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
const UTF8_FLAG = 0x0800;
const UNIX_FILE_MODE = 0o100644;
const MAX_CENTRAL_DIRECTORY = 64 * 1024 ** 2;

type ZipEntry = {
  path: string;
  name: Buffer;
  size: number;
  offset: number;
  localZip64: boolean;
  centralZip64: boolean;
  time: number;
  date: number;
  crc?: number;
};

function dosDateTime(ms: number) {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now());
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

type ZipPlan = Awaited<ReturnType<typeof planZip>>;

export async function planZip(files: { name: string; path: string }[]) {
  let offset = 0;
  let centralSize = 0;
  const entries: ZipEntry[] = [];
  for (const file of files) {
    const info = await stat(file.path);
    const name = Buffer.from(file.name, "utf8");
    const size = info.size;
    const localZip64 = size >= MAX32;
    const centralZip64 = localZip64 || offset >= MAX32;
    const entry: ZipEntry = {
      path: file.path,
      name,
      size,
      offset,
      localZip64,
      centralZip64,
      ...dosDateTime(info.mtimeMs),
    };
    entries.push(entry);
    offset += 30 + name.length + (localZip64 ? 20 : 0) + size;
    centralSize += 46 + name.length + (centralZip64 ? 28 : 0);
  }
  const zip64End = entries.length >= MAX16 || offset >= MAX32 || centralSize >= MAX32;
  return {
    entries,
    centralOffset: offset,
    centralSize,
    zip64End,
    totalSize: offset + centralSize + (zip64End ? 76 : 0) + 22,
  };
}

async function fileCrc(path: string, expectedSize: number) {
  let crc = 0;
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    crc = zlib.crc32(chunk, crc);
    size += chunk.length;
  }
  if (size !== expectedSize) throw new Error(`File changed while zipping: ${path}`);
  return crc;
}

function localHeader(entry: ZipEntry) {
  const header = Buffer.alloc(30 + entry.name.length + (entry.localZip64 ? 20 : 0));
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(entry.localZip64 ? 45 : 20, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(entry.time, 10);
  header.writeUInt16LE(entry.date, 12);
  header.writeUInt32LE(entry.crc!, 14);
  header.writeUInt32LE(entry.localZip64 ? MAX32 : entry.size, 18);
  header.writeUInt32LE(entry.localZip64 ? MAX32 : entry.size, 22);
  header.writeUInt16LE(entry.name.length, 26);
  header.writeUInt16LE(entry.localZip64 ? 20 : 0, 28);
  entry.name.copy(header, 30);
  if (entry.localZip64) {
    const extra = 30 + entry.name.length;
    header.writeUInt16LE(0x0001, extra);
    header.writeUInt16LE(16, extra + 2);
    header.writeBigUInt64LE(BigInt(entry.size), extra + 4);
    header.writeBigUInt64LE(BigInt(entry.size), extra + 12);
  }
  return header;
}

function centralHeader(entry: ZipEntry) {
  const header = Buffer.alloc(46 + entry.name.length + (entry.centralZip64 ? 28 : 0));
  const version = entry.centralZip64 ? 45 : 20;
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0300 | version, 4);
  header.writeUInt16LE(version, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(entry.time, 12);
  header.writeUInt16LE(entry.date, 14);
  header.writeUInt32LE(entry.crc!, 16);
  header.writeUInt32LE(entry.centralZip64 ? MAX32 : entry.size, 20);
  header.writeUInt32LE(entry.centralZip64 ? MAX32 : entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(entry.centralZip64 ? 28 : 0, 30);
  header.writeUInt32LE((UNIX_FILE_MODE << 16) >>> 0, 38);
  header.writeUInt32LE(entry.centralZip64 ? MAX32 : entry.offset, 42);
  entry.name.copy(header, 46);
  if (entry.centralZip64) {
    const extra = 46 + entry.name.length;
    header.writeUInt16LE(0x0001, extra);
    header.writeUInt16LE(24, extra + 2);
    header.writeBigUInt64LE(BigInt(entry.size), extra + 4);
    header.writeBigUInt64LE(BigInt(entry.size), extra + 12);
    header.writeBigUInt64LE(BigInt(entry.offset), extra + 20);
  }
  return header;
}

function endRecords(plan: ZipPlan) {
  const count = plan.entries.length;
  const records = [];
  if (plan.zip64End) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(0x0300 | 45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(plan.centralSize), 40);
    record.writeBigUInt64LE(BigInt(plan.centralOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(plan.centralOffset + plan.centralSize), 8);
    locator.writeUInt32LE(1, 16);
    records.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(plan.zip64End ? MAX16 : count, 8);
  end.writeUInt16LE(plan.zip64End ? MAX16 : count, 10);
  end.writeUInt32LE(plan.zip64End ? MAX32 : plan.centralSize, 12);
  end.writeUInt32LE(plan.zip64End ? MAX32 : plan.centralOffset, 16);
  records.push(end);
  return records;
}

async function* zipChunks(plan: ZipPlan) {
  for (const entry of plan.entries) {
    entry.crc = await fileCrc(entry.path, entry.size);
    yield localHeader(entry);
    let written = 0;
    for await (const chunk of createReadStream(entry.path)) {
      written += chunk.length;
      if (written > entry.size) break;
      yield chunk;
    }
    if (written !== entry.size) throw new Error(`File changed while zipping: ${entry.path}`);
  }
  for (const entry of plan.entries) yield centralHeader(entry);
  yield* endRecords(plan);
}

export function zipStream(plan: ZipPlan) {
  return Readable.from(zipChunks(plan), { objectMode: false });
}

export class ZipFormatError extends Error {}

export type ZipFileEntry = Awaited<ReturnType<typeof readZipEntries>>[number];

export async function readZipEntries(file: string) {
  const handle = await open(file, "r");
  const read = async (length: number, position: number) => {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead !== length) throw new ZipFormatError("The zip file is truncated.");
    return buffer;
  };
  try {
    const { size: fileSize } = await handle.stat();
    const tailSize = Math.min(fileSize, 22 + MAX16);
    const tail = await read(tailSize, fileSize - tailSize);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0 || end + 22 > tail.length) throw new ZipFormatError("The file is not a zip file.");
    let count = tail.readUInt16LE(end + 10);
    let centralSize = tail.readUInt32LE(end + 12);
    let centralOffset = tail.readUInt32LE(end + 16);
    if (count === MAX16 || centralSize === MAX32 || centralOffset === MAX32) {
      if (end < 20 || tail.readUInt32LE(end - 20) !== 0x07064b50)
        throw new ZipFormatError("The zip file is damaged.");
      const record = await read(56, Number(tail.readBigUInt64LE(end - 12)));
      if (record.readUInt32LE(0) !== 0x06064b50)
        throw new ZipFormatError("The zip file is damaged.");
      count = Number(record.readBigUInt64LE(32));
      centralSize = Number(record.readBigUInt64LE(40));
      centralOffset = Number(record.readBigUInt64LE(48));
    }
    if (centralOffset + centralSize > fileSize || centralSize > MAX_CENTRAL_DIRECTORY)
      throw new ZipFormatError("The zip file is damaged.");
    const central = await read(centralSize, centralOffset);
    const entries = [];
    let at = 0;
    for (let index = 0; index < count; index++) {
      if (at + 46 > central.length || central.readUInt32LE(at) !== 0x02014b50)
        throw new ZipFormatError("The zip file is damaged.");
      const nameEnd = at + 46 + central.readUInt16LE(at + 28);
      const extraEnd = nameEnd + central.readUInt16LE(at + 30);
      if (extraEnd > central.length) throw new ZipFormatError("The zip file is damaged.");
      const values = [
        central.readUInt32LE(at + 24),
        central.readUInt32LE(at + 20),
        central.readUInt32LE(at + 42),
      ];
      for (
        let extra = nameEnd;
        extra + 4 <= extraEnd;
        extra += 4 + central.readUInt16LE(extra + 2)
      ) {
        if (central.readUInt16LE(extra) !== 0x0001) continue;
        let field = extra + 4;
        for (const [slot, value] of values.entries()) {
          if (value !== MAX32) continue;
          values[slot] = Number(central.readBigUInt64LE(field));
          field += 8;
        }
      }
      const [size, compressedSize, localOffset] = values;
      const local = await read(30, localOffset);
      if (local.readUInt32LE(0) !== 0x04034b50)
        throw new ZipFormatError("The zip file is damaged.");
      entries.push({
        name: central.toString("utf8", at + 46, nameEnd),
        stored: central.readUInt16LE(at + 10) === 0 && size === compressedSize,
        crc: central.readUInt32LE(at + 16),
        size,
        dataOffset: localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28),
      });
      at = extraEnd + central.readUInt16LE(at + 32);
    }
    return entries;
  } finally {
    await handle.close();
  }
}

export async function extractZipEntry(file: string, entry: ZipFileEntry, target: string) {
  if (!entry.stored)
    throw new ZipFormatError(
      `${entry.name} is compressed. Only uncompressed zip files are supported.`,
    );
  let crc = 0;
  const checksum = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      crc = zlib.crc32(chunk, crc);
      done(null, chunk);
    },
  });
  const source =
    entry.size > 0
      ? createReadStream(file, { start: entry.dataOffset, end: entry.dataOffset + entry.size - 1 })
      : Readable.from([]);
  await pipeline(source, checksum, createWriteStream(target));
  if (crc !== entry.crc) throw new ZipFormatError(`${entry.name} is damaged.`);
}
