import { requireHousehold } from "@/lib/session";
import { SetupForm } from "../../setup/form";
import { Shell } from "../../ui";
import { addGroupAction } from "../actions";

export const metadata = { title: "Add a group · Clementine" };
export const dynamic = "force-dynamic";

// Another household or business for someone who already uses Clementine. They
// keep their place in the groups they are in and switch between them from
// the header.
export default async function NewGroupPage() {
  const { me, home, today } = await requireHousehold();
  const timezones = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")];
  return (
    <Shell home={home} me={me} today={today} title="Add a group">
      <div className="max-w-sm">
        <p className="mb-6 text-sm text-muted-foreground">
          A group keeps its own costs, rules and balance. Name it and say who the other person is.
        </p>
        <SetupForm
          action={addGroupAction}
          email={me.email}
          myName={me.displayName}
          timezone={home.timezone}
          timezones={timezones}
          submitLabel="Add group"
        />
      </div>
    </Shell>
  );
}
