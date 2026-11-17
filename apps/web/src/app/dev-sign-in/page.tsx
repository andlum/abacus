import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { member } from "@/db/schema";
import { isIsoDate } from "@abacus/core/dates";
import { DEV_AUTH_COOKIE, DEV_TODAY_COOKIE, devAuthEnabled } from "@/lib/dev-auth";

export const dynamic = "force-dynamic";

async function signInAs(form: FormData) {
  "use server";
  if (!devAuthEnabled()) notFound();
  const jar = await cookies();
  jar.set(DEV_AUTH_COOKIE, String(form.get("memberId")), { httpOnly: true, sameSite: "lax", path: "/" });
  const today = String(form.get("today") ?? "");
  if (isIsoDate(today)) jar.set(DEV_TODAY_COOKIE, today, { httpOnly: true, sameSite: "lax", path: "/" });
  else jar.delete(DEV_TODAY_COOKIE);
  redirect("/");
}

// Pick a member without a password. Exists only when ABACUS_E2E=1 outside a
// production build; see src/lib/dev-auth.ts.
export default async function DevSignIn() {
  if (!devAuthEnabled()) notFound();
  const members = await getDb().select().from(member).orderBy(member.displayName);
  const today = (await cookies()).get(DEV_TODAY_COOKIE)?.value ?? "";
  return (
    <main>
      <h1>Local sign-in</h1>
      <p className="note">
        This page stands in for the real sign-in on your own machine. It does not exist in the deployed app.
      </p>
      {members.length === 0 ? (
        <p>
          No members yet. Run <code>pnpm db:provision</code> first.
        </p>
      ) : (
        <form action={signInAs} className="panel">
          <label>
            Pretend today is (leave empty for the real date)
            <input type="date" name="today" defaultValue={today} />
          </label>
          <div className="row">
            {members.map((m) => (
              <button key={m.id} name="memberId" value={m.id}>
                Sign in as {m.displayName}
              </button>
            ))}
          </div>
        </form>
      )}
    </main>
  );
}
