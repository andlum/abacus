"use client";

import { Eye, EyeOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { useHydrated } from "../action-form";

type Mode = "sign-in" | "sign-up" | "forgot" | "reset";

const ERRORS: Record<string, string> = {
  INVALID_TOKEN: "That link has expired or was already used. Ask for a new one.",
  invalid_token: "That link has expired or was already used. Ask for a new one.",
};

type Props = {
  resetToken?: string;
  initialError?: string;
  // Set when the confirmation link was opened in another browser than the one
  // that signed up: the password typed then was discarded.
  needsPassword?: boolean;
  // Whether someone nobody invited may create an account and a household.
  canStart: boolean;
};

export function SignInForm({ resetToken, initialError, needsPassword, canStart }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(resetToken ? "reset" : needsPassword ? "forgot" : "sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Offer to send the confirmation email again after a sign-in is refused for it.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  // The form only sends through JavaScript; until then it cannot be sent.
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(initialError ? (ERRORS[initialError] ?? initialError) : null);
  const [notice, setNotice] = useState<string | null>(
    needsPassword && !resetToken
      ? "Your email is confirmed. You still need a password: enter your email and we will send you a link to choose one."
      : null,
  );

  const switchTo = (m: Mode) => {
    setMode(m);
    setShown(false);
    setError(null);
    setNotice(null);
    setUnconfirmed(false);
  };

  async function resend() {
    setBusy(true);
    try {
      const { error } = await authClient.sendVerificationEmail({ email, callbackURL: "/" });
      setNotice(
        error
          ? "Could not send it just now. Try again in a while."
          : `If ${email} has an account waiting for confirmation, a new link is on its way.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setUnconfirmed(false);
    try {
      if (mode === "sign-in") {
        const { error } = await authClient.signIn.email({ email, password, callbackURL: "/" });
        if (error?.code === "EMAIL_NOT_VERIFIED") {
          setNotice(`Confirm your email first: open the link we sent to ${email} when you signed up.`);
          setUnconfirmed(true);
        } else if (error) {
          setError(error.message ?? "Sign-in failed.");
        } else {
          router.push("/");
          router.refresh();
        }
      } else if (mode === "sign-up") {
        // For an invited email the server replaces the name with the member's.
        const { error } = await authClient.signUp.email({ email, password, name: email, callbackURL: "/" });
        // The reply is the same for every address, so it says nothing about who was invited.
        if (error) setError(error.message ?? "Could not create the account.");
        else setNotice(`Check ${email}. If it can sign up, a link to confirm it and sign in is on its way.`);
      } else if (mode === "forgot") {
        const { error } = await authClient.requestPasswordReset({ email, redirectTo: "/sign-in" });
        if (error) setError(error.message ?? "Could not send the reset link.");
        else setNotice(`If ${email} has an account, a reset link is on its way.`);
      } else {
        const { error } = await authClient.resetPassword({ newPassword: password, token: resetToken! });
        if (error) setError(ERRORS[error.code ?? ""] ?? error.message ?? "Could not set the password.");
        else {
          setNotice("Password changed. Sign in with it.");
          setPassword("");
          setMode("sign-in");
        }
      }
    } finally {
      setBusy(false);
    }
  }

  const title = { "sign-in": "Sign in", "sign-up": "Create your account", forgot: "Reset your password", reset: "Choose a new password" }[mode];
  const action = { "sign-in": "Sign in", "sign-up": "Create account", forgot: "Send reset link", reset: "Set password" }[mode];

  return (
    <form onSubmit={submit} className="my-0 flex flex-col gap-4 rounded-xl border border-border/70 bg-card p-6 shadow-soft">
      <h2 className="mt-0 mb-0 font-sans text-base font-semibold tracking-normal">{title}</h2>
      {mode === "sign-up" && (
        <p className="text-sm text-muted-foreground">
          {canStart
            ? "Invited to a household? Use the email address you were invited under. Otherwise you will set up a new household next."
            : "Use the email address you were invited under."}
        </p>
      )}
      {mode !== "reset" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      )}
      {mode !== "forgot" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">{mode === "sign-in" ? "Password" : "New password"}</Label>
          <div className="relative">
            <Input
              id="password"
              type={shown ? "text" : "password"}
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              required
              minLength={8}
              className="pr-10"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              data-slot="toggle"
              className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label={shown ? "Hide password" : "Show password"}
              aria-pressed={shown}
              onClick={() => setShown(!shown)}
            >
              {shown ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {unconfirmed && mode === "sign-in" && (
        <button type="button" data-slot="link" disabled={busy} className="self-start text-sm text-muted-foreground underline decoration-foreground/20 underline-offset-4 transition-colors hover:text-primary hover:decoration-primary" onClick={resend}>
          Send the confirmation email again
        </button>
      )}
      <Button type="submit" size="lg" disabled={busy || !hydrated}>
        {action}
      </Button>
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm">
        {mode !== "sign-in" && (
          <button type="button" data-slot="link" className="text-muted-foreground underline decoration-foreground/20 underline-offset-4 transition-colors hover:text-primary hover:decoration-primary" onClick={() => switchTo("sign-in")}>
            Sign in
          </button>
        )}
        {mode !== "sign-up" && (
          <button type="button" data-slot="link" className="text-muted-foreground underline decoration-foreground/20 underline-offset-4 transition-colors hover:text-primary hover:decoration-primary" onClick={() => switchTo("sign-up")}>
            First time here? Create your account
          </button>
        )}
        {mode === "sign-in" && (
          <button type="button" data-slot="link" className="text-muted-foreground underline decoration-foreground/20 underline-offset-4 transition-colors hover:text-primary hover:decoration-primary" onClick={() => switchTo("forgot")}>
            Forgot password
          </button>
        )}
      </div>
    </form>
  );
}
