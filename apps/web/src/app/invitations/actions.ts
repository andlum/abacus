"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { UserError } from "@abacus/core/errors";
import { field, type ActionState } from "@/lib/action";
import { acceptInvitation, declineInvitation } from "@/lib/membership";
import { GROUP_COOKIE, requireSignedInUser } from "@/lib/session";

// Says yes to one invitation, switches to that group and goes home.
export async function acceptInvitationAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { db, user } = await requireSignedInUser();
  let joined;
  try {
    joined = await acceptInvitation(db, user, field(form, "memberId"));
  } catch (e) {
    if (e instanceof UserError) return { error: e.message };
    throw e;
  }
  (await cookies()).set(GROUP_COOKIE, joined.householdId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/", "layout");
  redirect("/");
}

// Says no to one invitation. The page then shows what is left, or sends the
// person on if nothing is.
export async function declineInvitationAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { db, user } = await requireSignedInUser();
  try {
    await declineInvitation(db, user, field(form, "memberId"));
  } catch (e) {
    if (e instanceof UserError) return { error: e.message };
    throw e;
  }
  revalidatePath("/", "layout");
  return { done: Date.now() };
}
