import { isAbsolute, relative, sep } from "node:path";

const socketDenial =
  /socket\.py[\s\S]*PermissionError: \[Errno 1\] Operation not permitted|\b(?:listen|connect|bind)\b[^\n]{0,160}\bEPERM\b/;
// Node's own message for a refused process start: `Error: spawnSync /usr/bin/node EPERM`, or
// `Error: spawn EPERM` (Node names the file only for EACCES, ENOENT, EMFILE, ENFILE, EAGAIN);
// the file may contain spaces. EACCES is not here: `spawn ./run.sh EACCES` is an unexecutable
// file in the product.
const spawnDenial = /\b(?:spawn|spawnSync|fork|exec|execSync)(?: +[^\n]{1,200}?)? +EPERM\b/;
const permissionDenial = /\b(?:EPERM|EACCES|EROFS)\b|Operation not permitted|Permission denied/i;

export function sandboxDenial(text: string, root: string): "denied" | "possible" | undefined {
  if (socketDenial.test(text) || spawnDenial.test(text)) return "denied";
  const sandbox =
    process.env.CODEX_SANDBOX ||
    process.env.CODEX_SANDBOX_NETWORK_DISABLED ||
    process.env.CODEX_PERMISSION_PROFILE;
  if (!sandbox || !permissionDenial.test(text)) return undefined;
  const paths = [
    ...text.matchAll(/\b(?:EACCES|EROFS)\b[^\n]*?['"]([^'"\n]+)['"]/g),
    ...text.matchAll(/\b(?:spawn|spawnSync|fork|exec|execSync) +([^\n]{1,200}?) +EACCES\b/g),
  ];
  if (
    paths.some((match) => {
      const path = match[1];
      if (!path || !isAbsolute(path)) return false;
      const local = relative(root, path);
      return local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local);
    })
  )
    return "denied";
  return "possible";
}

export const SANDBOX_NOTE =
  "VISP: the host sandbox may have denied process, filesystem or network access. Inspect the recorded denial and rerun the same visp command with the host's supported sandbox escalation when appropriate; do not change working product code to work around host restrictions.";
