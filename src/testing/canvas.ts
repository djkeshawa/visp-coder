/// <reference lib="dom" />

export interface CanvasRegion {
  readonly selector: string;
  /** Coordinates in backing-store pixels, not CSS pixels. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: readonly number[];
  /** Per-channel tolerance from 0 to 255; default is exact matching. */
  readonly tolerance?: number;
}
export interface CanvasMeasurement {
  readonly pixels: number;
  readonly matchingPixels: number;
  readonly matchingRatio: number;
}

/** Self-contained for page.evaluate. Measures actual 2D pixels; not a screenshot/layout or aesthetic verdict. */
export function measureCanvasRegion(region: CanvasRegion): CanvasMeasurement {
  const values = [region.x, region.y, region.width, region.height];
  if (
    !values.every(Number.isSafeInteger) ||
    region.x < 0 ||
    region.y < 0 ||
    region.width < 1 ||
    region.height < 1 ||
    region.width * region.height > 1_000_000
  )
    throw new Error("Canvas region must contain 1 to 1,000,000 pixels with integer coordinates");
  const tolerance = region.tolerance ?? 0;
  if (
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    tolerance > 255 ||
    region.color.length !== 4 ||
    !region.color.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
  )
    throw new Error("Expected an RGBA color and tolerance between 0 and 255");
  const matches = document.querySelectorAll(region.selector);
  const canvas = matches[0];
  if (matches.length !== 1 || !(canvas instanceof HTMLCanvasElement))
    throw new Error("Expected exactly one 2D canvas");
  if (region.x + region.width > canvas.width || region.y + region.height > canvas.height)
    throw new Error("Canvas region extends beyond the backing store");
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error(
      "Canvas has no 2D context; inspect WebGL through screenshots or an appropriate readback adapter",
    );
  // A tainted canvas throws instead of silently becoming an empty passing measurement.
  const { data } = context.getImageData(region.x, region.y, region.width, region.height);
  let matchingPixels = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (
      region.color.every(
        (value, channel) => Math.abs((data[offset + channel] ?? -256) - value) <= tolerance,
      )
    )
      matchingPixels++;
  }
  const pixels = region.width * region.height;
  return { pixels, matchingPixels, matchingRatio: matchingPixels / pixels };
}
