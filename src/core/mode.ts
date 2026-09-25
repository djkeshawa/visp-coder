/**
 * POSIX exposes execute bits; Windows does not. On Windows, exact generated
 * content plus the live guard handshake establishes health instead.
 */
export function isExecutableMode(
  mode: number | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return mode !== undefined && (platform === "win32" || (mode & 0o111) !== 0);
}
