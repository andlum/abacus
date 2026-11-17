import { SignOutButton } from "@/components/sign-out-button";
import { requireFounder } from "@/lib/session";
import { createHouseholdAction } from "./actions";
import { SetupForm } from "./form";

export const metadata = { title: "Set up your group · Clementine" };
export const dynamic = "force-dynamic";

// Where a signed-in person in no group lands when they may start one:
// the first person on a fresh install, or anyone when sign-up is open.
export default async function SetupPage() {
  const founder = await requireFounder();
  const timezones = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")];
  return (
    <main className="mx-auto max-w-sm px-4 py-12">
      <h1 className="mb-2">Set up your group</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Clementine splits costs between two people, in a household or a small business. Name yours and say who the other person is.
      </p>
      <SetupForm action={createHouseholdAction} email={founder.email} timezones={timezones} submitLabel="Create group" />
      <div className="mt-6">
        <SignOutButton>sign out</SignOutButton>
      </div>
    </main>
  );
}
