// Ids are UUIDs. One that arrives from a URL or a form is checked here
// before it reaches a query, so a malformed one is "not found" and not a
// Postgres error (22P02) and a 500.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string | null | undefined): value is string => !!value && UUID.test(value);

// True for the error Postgres raises when text cannot be read as the
// column's type, such as "not-an-id" for a uuid. Drizzle wraps it, so the
// chain of causes is followed.
export function isMalformedInput(e: unknown): boolean {
  for (let cur = e, depth = 0; cur && typeof cur === "object" && depth < 5; cur = (cur as { cause?: unknown }).cause, depth++) {
    if ((cur as { code?: unknown }).code === "22P02") return true;
  }
  return false;
}
