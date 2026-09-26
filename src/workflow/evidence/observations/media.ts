import { createHash } from "node:crypto";

export function digestBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function imageDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  return (
    pngDimensions(bytes) ?? gifDimensions(bytes) ?? jpegDimensions(bytes) ?? webpDimensions(bytes)
  );
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  const signature = "89504e470d0a1a0a";
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== signature) return undefined;
  if (bytes.subarray(12, 16).toString("ascii") !== "IHDR") return undefined;
  return positiveDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

function gifDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 10 || !/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) {
    return undefined;
  }
  return positiveDimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  for (let offset = 2; offset + 8 < bytes.length; ) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      return positiveDimensions(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

function webpDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (
    bytes.length < 30 ||
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    return undefined;
  }
  const kind = bytes.subarray(12, 16).toString("ascii");
  if (kind === "VP8X") {
    return positiveDimensions(1 + readUInt24LE(bytes, 24), 1 + readUInt24LE(bytes, 27));
  }
  if (kind === "VP8 " && bytes.length >= 30) {
    return positiveDimensions(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
  }
  if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return positiveDimensions(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
  }
  return undefined;
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function positiveDimensions(
  width: number,
  height: number,
): { width: number; height: number } | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}
