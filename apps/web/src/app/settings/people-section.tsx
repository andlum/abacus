import { pendingInvites } from "@/lib/membership";
import type { requireHousehold } from "@/lib/session";
import { ActionForm } from "../action-form";
import { cancelInviteAction, invitePersonAction, reinviteAction, removeMemberAction } from "../actions";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;

const when = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

// Who is in the group, their invitations, and the form to add someone.
export function PeopleSection({ me, home, members }: Ctx) {
  // The person looking has signed in, whatever their row says (dev-auth.ts).
  const invites = pendingInvites(members.filter((m) => m.id !== me.id), home.timezone);
  const waiting = new Map(invites.map((i) => [i.id, i]));
  return (
    <section aria-labelledby="people" className="mb-10">
      <h2 id="people">People in {home.name}</h2>
      <ul data-slot="people" className="divide-y divide-border/70 rounded-xl border border-border/70 bg-card shadow-soft">
        {members.map((m) => {
          const invite = waiting.get(m.id);
          const removed = m.removedAt !== null;
          return (
            <li key={m.id} className="grid gap-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <span className="min-w-0">
                  <span className="block font-medium">
                    {m.displayName}
                    {m.id === me.id && " (you)"}
                  </span>
                  <span className="block truncate text-sm text-muted-foreground">{m.email}</span>
                </span>
                {removed ? (
                  <span className="tag warn">access removed {when.format(m.removedAt!)}</span>
                ) : !invite ? (
                  <span className="tag ok">joined</span>
                ) : invite.cancelledOn ? (
                  <span className="tag warn">invite cancelled {when.format(new Date(invite.cancelledOn))}</span>
                ) : (
                  <span className="tag">invited {when.format(new Date(invite.invitedOn))}, not joined yet</span>
                )}
              </div>
              {!removed && !invite && m.id !== me.id && (
                <div>
                  <ActionForm
                    action={removeMemberAction}
                    done="Access removed"
                    confirm={`Remove ${m.displayName}'s access? They will be signed out and will no longer see ${home.name}; their devices and agents stop working. Their past costs and payments stay, and they stop counting in splits from today.`}
                  >
                    <input type="hidden" name="memberId" value={m.id} />
                    <button className="danger">Remove access</button>
                  </ActionForm>
                </div>
              )}
              {(invite || removed) && (
                <div className="flex flex-wrap items-start gap-2">
                  <ActionForm action={reinviteAction} done="Invite sent" className="flex grow flex-wrap items-start gap-2">
                    <input type="hidden" name="memberId" value={m.id} />
                    <input
                      type="email"
                      name="email"
                      required
                      defaultValue={m.email}
                      aria-label={`Email for ${m.displayName}`}
                      className="min-w-0 grow basis-56"
                    />
                    <button>{removed || invite?.cancelledOn ? "Invite again" : "Send invite"}</button>
                  </ActionForm>
                  {invite && !invite.cancelledOn && (
                    <ActionForm
                      action={cancelInviteAction}
                      done="Invite cancelled"
                      confirm={`Cancel the invite for ${m.displayName}? ${m.email} will no longer be able to join. ${m.displayName} stays in your rules and past costs.`}
                    >
                      <input type="hidden" name="memberId" value={m.id} />
                      <button className="quiet">Cancel invite</button>
                    </ActionForm>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {members.some((m) => m.removedAt) && (
        <p className="note">Someone whose access was removed still counts in splits and the balance.</p>
      )}
      <h3 className="mt-6">Add someone</h3>
      <ActionForm action={invitePersonAction} done="Invite sent" className="flex flex-wrap items-start gap-2">
        <input name="displayName" required maxLength={80} placeholder="Name" aria-label="Their name" className="min-w-0 grow basis-40" />
        <input type="email" name="email" required placeholder="Email" aria-label="Their email" className="min-w-0 grow basis-56" />
        <button>Add and invite</button>
      </ActionForm>
      <p className="note">
        They are emailed an invitation and join when they accept it. From that day, costs split evenly include them;
        costs dated earlier stay between the people who were here then. A rule with set percentages or amounts gives
        them nothing until someone changes it, and a split by income waits for their income.
      </p>
      {invites.length > 0 && (
        <p className="note">
          An invited person joins by creating an account with the email shown here. Send invite emails them the
          address of this site; change the email first if it was mistyped.
        </p>
      )}
    </section>
  );
}
