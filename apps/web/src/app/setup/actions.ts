"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { UserError } from "@abacus/core/errors";
import { getDb } from "@/db/client";
import type { GroupKind, Member } from "@/db/schema";
import { field, type ActionState } from "@/lib/action";
import { createHousehold, signUpPolicy } from "@/lib/household-setup";
import { inviteFirstPartner } from "@/lib/invite-mail";
import { createMailer } from "@/lib/mail";
import { requireFounder } from "@/lib/session";
import { siteAddress } from "@/lib/site";

// Creates the first group for the person signed in, then sends them home.
export async function createHouseholdAction(_: ActionState, form: FormData): Promise<ActionState> {
  const founder = await requireFounder();
  const db = getDb();
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
  revalidatePath("/", "layout");
  redirect("/");
}
