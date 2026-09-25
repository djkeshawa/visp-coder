export function paginate(entries, page, pageSize) {
  const start = (page - 1) * pageSize;
  return entries.slice(start, start + pageSize - 1);
}
