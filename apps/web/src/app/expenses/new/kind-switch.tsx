"use client";

import { useState, type ReactNode } from "react";

type Kind = "once" | "recurring";

// Asks whether the expense happens once or keeps coming, and shows the
// details for that answer. The other details are disabled, so the browser
// leaves them out of what is sent.
export function KindSwitch({
  once,
  recurring,
  initial = "once",
}: {
  once: ReactNode;
  recurring: ReactNode;
  initial?: Kind;
}) {
  const [kind, setKind] = useState<Kind>(initial);
  const choice = (value: Kind, label: string) => (
    <label className="check">
      <input type="radio" name="kind" value={value} checked={kind === value} onChange={() => setKind(value)} />
      {label}
    </label>
  );
  return (
    <>
      <fieldset>
        <legend>How often does this happen?</legend>
        <div className="row">
          {choice("once", "One-time")}
          {choice("recurring", "Recurring")}
        </div>
      </fieldset>
      <fieldset className="plain" hidden={kind !== "once"} disabled={kind !== "once"}>
        {once}
      </fieldset>
      <fieldset className="plain" hidden={kind !== "recurring"} disabled={kind !== "recurring"}>
        {recurring}
      </fieldset>
    </>
  );
}
