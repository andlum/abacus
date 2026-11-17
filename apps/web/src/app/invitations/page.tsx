import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";
import { requireInvitee } from "@/lib/session";
import { ActionForm } from "../action-form";
import { acceptInvitationAction, declineInvitationAction } from "./actions";

export const metadata = { title: "Invitations · Clementine" };
export const dynamic = "force-dynamic";

const KIND = { household: "household", business: "small business" } as const;

function who(names: string[]) {
  if (names.length === 0) return "Nobody has joined yet.";
  if (names.length === 1) return `${names[0]} is already in it.`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are already in it.`;
}

// Where a signed-in person sees the groups that named their email address.
// Nothing links them to a group until they press Join.
export default async function InvitationsPage() {
  const { invitations, hasGroup, mayStart } = await requireInvitee();
  return (
    <main className="mx-auto max-w-lg px-4 py-12">
      <h1 className="mb-2">{invitations.length === 1 ? "You have been invited to a group" : "You have been invited to groups"}</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Joining lets the group's members see the shared costs you enter there. If you do not recognise a group, decline.
      </p>
      <ul className="mb-6 grid gap-3">
        {invitations.map((inv) => (
          <li key={inv.memberId} className="grid gap-3 rounded-xl border p-4">
            <div>
              <p className="font-medium">
                {inv.householdName} <span className="tag">{KIND[inv.kind]}</span>
              </p>
              <p className="text-sm text-muted-foreground">
                {who(inv.members)} You were added as {inv.displayName}.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <ActionForm action={acceptInvitationAction} done={`Joined ${inv.householdName}`}>
                <input type="hidden" name="memberId" value={inv.memberId} />
                <button className="primary">Join</button>
              </ActionForm>
              <ActionForm action={declineInvitationAction} done="Invitation declined">
                <input type="hidden" name="memberId" value={inv.memberId} />
                <button className="quiet">Decline</button>
              </ActionForm>
            </div>
          </li>
        ))}
      </ul>
      {hasGroup ? (
        <p className="text-sm">
          <Link href="/" className="underline underline-offset-2">
            Back to your group
          </Link>
        </p>
      ) : (
        <>
          {mayStart && (
            <p className="mb-6 text-sm">
              Or{" "}
              <Link href="/setup" className="underline underline-offset-2">
                start a group of your own
              </Link>
              .
            </p>
          )}
          <SignOutButton>sign out and try another email</SignOutButton>
        </>
      )}
    </main>
  );
}
