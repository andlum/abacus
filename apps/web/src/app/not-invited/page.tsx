import { SignOutButton } from "@/components/sign-out-button";

export default function NotInvited() {
  return (
    <main>
      <h1>No household for this account</h1>
      <p>
        This sign-in is not linked to a household. If you expected access, sign in with the email address you were
        invited under.
      </p>
      <SignOutButton>sign out and try another email</SignOutButton>
    </main>
  );
}
