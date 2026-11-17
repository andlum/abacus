"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { UserError } from "@abacus/core/errors";
import { field, type ActionState } from "@/lib/action";
import { DEV_AUTH_COOKIE, devAuthEnabled } from "@/lib/dev-auth";
import { setDefaultGroup } from "@/lib/groups";
import { createHousehold, signUpPolicy } from "@/lib/household-setup";
import { inviteFirstPartner } from "@/lib/invite-mail";
import { createMailer } from "@/lib/mail";
import { siteAddress } from "@/lib/site";
import { GROUP_COOKIE, requireGroups } from "@/lib/session";
import type { GroupKind, Member } from "@/db/schema";

// Points the browser at one of the person's groups. `mine` is their own
// member row there, so this can never land in someone else's group.
async function workIn(mine: Member) {
  const jar = await cookies();
  // The local stand-in signs in as a member row, so switching swaps the row.
  if (devAuthEnabled()) jar.set(DEV_AUTH_COOKIE, mine.id, { httpOnly: true, sameSite: "lax", path: "/" });
  else jar.set(GROUP_COOKIE, mine.householdId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  revalidatePath("/", "layout");
}

// Switches to another of the person's groups and goes to its home page:
// whatever was on screen belonged to the group being left.
export async function switchGroupAction(form: FormData) {
  const { memberships } = await requireGroups();
  const mine = memberships.find((m) => m.householdId === field(form, "groupId"));
  if (mine) await workIn(mine);
  redirect("/");
}

// Makes a group the one this person lands in. Stays on the page.
export async function setDefaultGroupAction(form: FormData) {
  const { db, memberships } = await requireGroups();
  try {
    await setDefaultGroup(db, memberships, field(form, "groupId"));
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
  }
  revalidatePath("/", "layout");
}

// Adds a group for the person signed in, then switches to it.
export async function addGroupAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { db, founder } = await requireGroups();
  let mine: Member;
  try {
    mine = await createHousehold(
      db,
      founder,
      {
        householdName: field(form, "householdName"),
        kind: field(form, "kind") as GroupKind,
        timezone: field(form, "timezone"),
        myName: field(form, "myName"),
        partnerName: field(form, "partnerName"),
        partnerEmail: field(form, "partnerEmail"),
      },
      signUpPolicy(),
    );
  } catch (e) {
    if (e instanceof UserError) return { error: e.message };
    throw e;
  }
  // The group exists whether or not the email goes: a failure is logged and
  // the pending invite's "Send invite" button in Settings stays as the fallback.
  try {
    await inviteFirstPartner(db, createMailer(), mine, await siteAddress());
  } catch (e) {
    console.error("invite email failed", e);
  }
  await workIn(mine);
  redirect("/");
}
