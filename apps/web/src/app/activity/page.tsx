import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { recentActivity } from "@/lib/activity";
import { requireHousehold } from "@/lib/session";
import { Money, Shell } from "../ui";

export const metadata = { title: "Activity · Clementine" };
export const dynamic = "force-dynamic";

const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

// What changed in the group lately and who changed it, newest first.
export default async function ActivityPage() {
  const ctx = await requireHousehold();
  const { me, db, members } = ctx;
  const nameOf = new Map(members.map((m) => [m.id, m.displayName]));
  const activity = await recentActivity(db, me.householdId, nameOf, 50, me);

  return (
    <Shell {...ctx} title="Activity">
      <Card aria-label="Recent activity" role="region">
        <CardContent>
          {activity.length === 0 ? (
            <p className="note">Nothing yet.</p>
          ) : (
            <ul className="list-none divide-y divide-border/70 pl-0 space-y-0">
              {activity.map((a) => (
                <li key={a.id} className="flex items-baseline gap-4 py-2.5 text-sm">
                  <time dateTime={a.at.toISOString()} className="w-14 shrink-0 text-muted-foreground tabular-nums">
                    {day.format(a.at)}
                  </time>
                  <span className="grow">
                    {a.href ? (
                      <Link href={a.href} className="no-underline hover:underline">
                        {a.text}
                      </Link>
                    ) : (
                      a.text
                    )}
                    <span className="block text-xs text-muted-foreground">{a.who}</span>
                  </span>
                  {a.cents !== null && (
                    <span className="num font-medium">
                      <Money cents={a.cents} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </Shell>
  );
}
