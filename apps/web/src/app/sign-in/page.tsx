import { getDb } from "@/db/client";
import { canStartHousehold, signUpPolicy } from "@/lib/household-setup";
import { ClementineMark } from "../logo";
import { SignInForm } from "./form";

export const metadata = { title: "Sign in · Clementine" };

// One page for every step of getting in: sign in, create an account (for an
// invited email, or to set up a new household), ask for a password reset, and set the new password when the
// reset link (which carries ?token=) comes back here.
export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { token, error, notice } = await searchParams;
  const canStart = await canStartHousehold(getDb(), signUpPolicy());
  return (
    <main className="mx-auto max-w-sm px-4 py-16 sm:py-24">
      <div className="mb-8 flex flex-col items-center gap-4">
        <ClementineMark className="size-14 rounded-[16px] shadow-float" />
        <h1 className="mb-0">Clementine</h1>
      </div>
      <SignInForm resetToken={token} initialError={error} needsPassword={notice === "set-password"} canStart={canStart} />
    </main>
  );
}
