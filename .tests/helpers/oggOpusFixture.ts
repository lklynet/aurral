// Builds a small but structurally valid Ogg Opus file in memory. music-metadata reads the
// duration of an Ogg stream from the granule position of its last page, so the packets
// can be filler. The file has more than 12 pages, the point after which music-metadata
// stops reading unless it is asked for the duration.

const OPUS_RATE = 48000;
const PRE_SKIP = 312;
const SERIAL = 0x4155_5252;

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index << 24;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 0x8000_0000 ? (value << 1) ^ 0x04c1_1db7 : value << 1;
  }
  return value >>> 0;
});

function oggCrc(bytes: Uint8Array) {
  let crc = 0;
  for (const byte of bytes) {
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] ?? 0)) >>> 0;
  }
  return crc;
}

function oggPage(sequence: number, granule: bigint, flags: number, packet: Uint8Array) {
  if (packet.length >= 255) throw new Error("fixture packets must fit one lacing segment");
  const page = new Uint8Array(27 + 1 + packet.length);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0);
  page[5] = flags;
  view.setBigInt64(6, granule, true);
  view.setUint32(14, SERIAL, true);
  view.setUint32(18, sequence, true);
  page[26] = 1;
  page[27] = packet.length;
  page.set(packet, 28);
  view.setUint32(22, oggCrc(page), true);
  return page;
}

function opusHead() {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  head[8] = 1;
  head[9] = 2;
  view.setUint16(10, PRE_SKIP, true);
  view.setUint32(12, OPUS_RATE, true);
  return head;
}

function opusTags() {
  const vendor = new TextEncoder().encode("aurral-test");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const view = new DataView(tags.buffer);
  tags.set(new TextEncoder().encode("OpusTags"), 0);
  view.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  return tags;
}

/** An Ogg Opus file of `seconds` of audio, spread over `audioPages` pages. */
export function buildOggOpus({
  seconds,
  audioPages = 40,
}: {
  seconds: number;
  audioPages?: number;
}) {
  const total = BigInt(Math.round(seconds * OPUS_RATE));
  const pages = [oggPage(0, 0n, 0x02, opusHead()), oggPage(1, 0n, 0, opusTags())];
  for (let index = 1; index <= audioPages; index += 1) {
    const granule = BigInt(PRE_SKIP) + (total * BigInt(index)) / BigInt(audioPages);
    // 0xf8 is the Opus table-of-contents byte for a 20 ms CELT frame.
    const packet = new Uint8Array(100).fill(0xf8);
    pages.push(oggPage(index + 1, granule, index === audioPages ? 0x04 : 0, packet));
  }
  return Buffer.concat(pages);
}
