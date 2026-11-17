import type { EntityEntry } from "@/lib/entity-activity";

// "13 Nov 2026", on the group's own calendar (its timezone). Anything on a
// page that dates an entry uses this, so two lists never disagree on a day.
export const dayIn = (timezone: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: timezone });

// One thing's history, oldest first, a line each: "13 Nov 2026 · Alex
// edited this payment — Amount $50.00 → $40.00". Days are the group's own
// (its timezone), like the rest of the app. `title` is "Activity" on a
// page of its own, "History" beside a row in Settings.
export function ActivityPanel({
  entries,
  timezone,
  title = "Activity",
  open = false,
}: {
  entries: EntityEntry[];
  timezone: string;
  title?: string;
  open?: boolean;
}) {
  const day = dayIn(timezone);
  return (
    <details open={open}>
      <summary>{title}</summary>
      {entries.length === 0 ? (
        <p className="note">Nothing recorded yet.</p>
      ) : (
        // Wraps inside a Settings table, whose cells otherwise keep to one
        // line, but stays wide enough to read there.
        <ol className="list-none min-w-56 space-y-1.5 pl-0 text-sm whitespace-normal">
          {entries.map((e) => (
            <li key={e.id} className="[overflow-wrap:anywhere]">
              <time dateTime={e.at.toISOString()} className="text-muted-foreground tabular-nums">
                {day.format(e.at)}
              </time>{" "}
              · {e.text}
              {e.changes.length > 0 && <> — {e.changes.join("; ")}</>}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
