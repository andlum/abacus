// Where saving an edited expense sends someone back to: the list they came
// from, with its filters and page. It arrives in a form field, so anything
// that is not plainly one of this site's lists is refused, and the caller
// falls back to a list it builds itself.
export function returnTo(path: string | null | undefined): string | null {
  if (!path || path.length > 2000) return null;
  // Control characters, spaces and backslashes have no place in these links,
  // and some browsers read "/\" as the start of another site's address.
  if (/[\u0000- \u007f-\u009f\\\s]/.test(path)) return null;
  if (path === "/" || path.startsWith("/?")) return path;
  if (path === "/expenses" || path.startsWith("/expenses?")) return path;
  if (/^\/month\/\d{4}-\d{2}$/.test(path)) return path;
  return null;
}
