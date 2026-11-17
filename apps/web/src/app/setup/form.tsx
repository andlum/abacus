"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { ActionState } from "@/lib/action";
import { useHydrated } from "../action-form";

type Props = {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  email: string;
  timezones: string[];
  submitLabel: string;
  // Known already when someone adds a second group.
  myName?: string;
  timezone?: string;
};

// Names a group and its people (a business may be just you): the first one at /setup, and any after
// that at /groups/new. What was typed stays in place when the server refuses it.
export function SetupForm({ action, email, timezones, submitLabel, myName, timezone: knownTimezone }: Props) {
  const [state, send] = useActionState<ActionState, FormData>(action, {});
  const [pending, start] = useTransition();
  // The form only sends through JavaScript; until then it cannot be sent.
  const hydrated = useHydrated();
  const [timezone, setTimezone] = useState(knownTimezone ?? "UTC");
  const [kind, setKind] = useState("household");
  const needsPartner = kind === "household";

  // The browser knows where the person is; the server does not.
  useEffect(() => {
    if (knownTimezone) return;
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezones.includes(here)) setTimezone(here);
  }, [timezones, knownTimezone]);

  return (
    <form
      className="flex flex-col gap-4"
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        start(() => send(data));
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="kind">What it is</Label>
        <NativeSelect id="kind" name="kind" className="w-full" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="household">A household</option>
          <option value="business">A small business</option>
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="householdName">Name</Label>
        <Input id="householdName" name="householdName" placeholder="Maple Street" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="timezone">Timezone</Label>
        <NativeSelect
          id="timezone"
          name="timezone"
          className="w-full"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
        >
          {timezones.map((z) => (
            <option key={z} value={z}>
              {z.replaceAll("_", " ")}
            </option>
          ))}
        </NativeSelect>
        <p className="text-sm text-muted-foreground">Decides which day "today" is, and so when a recurring cost falls due.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="myName">Your name</Label>
        <Input id="myName" name="myName" autoComplete="given-name" defaultValue={myName} required />
        <p className="text-sm text-muted-foreground">You are signed in as {email}.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="partnerName">The other person's name{needsPartner ? "" : " (optional)"}</Label>
        <Input id="partnerName" name="partnerName" autoComplete="off" required={needsPartner} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="partnerEmail">The other person's email{needsPartner ? "" : " (optional)"}</Label>
        <Input id="partnerEmail" name="partnerEmail" type="email" autoComplete="off" required={needsPartner} />
        <p className="text-sm text-muted-foreground">
          {needsPartner ? "" : "Leave both empty if the business is just you. "}
          Clementine emails them an invitation. They join by creating an account with this address and accepting it.
        </p>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          Not saved: {state.error}.
        </p>
      )}
      <Button type="submit" disabled={pending || !hydrated}>
        {submitLabel}
      </Button>
    </form>
  );
}
