import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

/** Reads one pixel of a non-interlaced 8-bit RGB or RGBA PNG (what Chrome screenshots produce). */
export async function pngPixel(
  path: string,
  x: number,
  y: number,
): Promise<[number, number, number]> {
  const { width, height, channels, data } = parsePng(await readFile(path));
  if (x < 0 || y < 0 || x >= width || y >= height) throw new Error("Pixel outside the image");
  const stride = width * channels;
  let previous: Uint8Array = Buffer.alloc(stride);
  for (let line = 0; line <= y; line++) {
    const start = line * (stride + 1);
    const row = unfilter(
      data[start] ?? 0,
      data.subarray(start + 1, start + 1 + stride),
      previous,
      channels,
    );
    if (line === y)
      return [row[x * channels] ?? 0, row[x * channels + 1] ?? 0, row[x * channels + 2] ?? 0];
    previous = row;
  }
  throw new Error("Pixel outside the image");
}

function parsePng(bytes: Buffer) {
  let offset = 8;
  let header: Buffer | undefined;
  const idat: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = body;
    if (type === "IDAT") idat.push(body);
    offset += 12 + length;
  }
  const supported = header?.[8] === 8 && header[12] === 0 && [2, 6].includes(header[9] ?? 0);
  if (!header || !supported) throw new Error("Unsupported PNG");
  return {
    width: header.readUInt32BE(0),
    height: header.readUInt32BE(4),
    channels: header[9] === 6 ? 4 : 3,
    data: inflateSync(Buffer.concat(idat)),
  };
}

function unfilter(
  filter: number,
  source: Uint8Array,
  previous: Uint8Array,
  channels: number,
): Uint8Array {
  const row = Uint8Array.from(source);
  for (let i = 0; i < row.length; i++) {
    const left = i >= channels ? (row[i - channels] as number) : 0;
    const up = previous[i] as number;
    const upLeft = i >= channels ? (previous[i - channels] as number) : 0;
    const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter] ?? 0;
    row[i] = (row[i] as number) + predictor;
  }
  return row;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
