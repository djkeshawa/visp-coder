export function login(user) {
  if (typeof user !== "string" || user.length === 0) return undefined;
  return `${user}-token`;
}
