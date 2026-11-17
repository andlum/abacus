import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { UserError } from "@abacus/core/errors";
import { parseCents } from "@abacus/core/money";
import { isMalformedInput } from "./ids.ts";
import { requireHousehold } from "./session.ts";

export type ActionState = { error?: string; done?: number };

type Context = Awaited<ReturnType<typeof requireHousehold>>;

// Runs a server action for the signed-in member. A UserError comes back as
// a message for the form; anything else is a real failure. Returning a path
// sends the browser there.
export async function attempt(fn: (ctx: Context) => Promise<string | void>): Promise<ActionState> {
  const ctx = await requireHousehold();
  let to: string | void;
  try {
    to = await fn(ctx);
  } catch (e) {
    if (e instanceof UserError) return { error: e.message };
    // An id from the form that is not one, which Postgres refused to read.
    if (isMalformedInput(e)) {
      console.warn(e);
      return { error: "that is no longer there, or never was" };
    }
    throw e;
  }
  revalidatePath("/", "layout");
  if (to) redirect(to);
  return { done: Date.now() };
}

export const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

// A money field as cents. Empty gives null when `optional`.
export function moneyField(form: FormData, name: string, label: string, optional = false): number | null {
  const text = field(form, name);
  if (!text && optional) return null;
  const cents = parseCents(text);
  if (cents === null) throw new UserError(`${label} must be an amount like 1234.56`);
  return cents;
}

export function wholeField(form: FormData, name: string, label: string): number {
  const text = field(form, name);
  if (!/^\d{1,4}$/.test(text)) throw new UserError(`${label} must be a whole number`);
  return Number(text);
}
