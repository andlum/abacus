"use client";

import { useState, useTransition } from "react";
import { useHydrated } from "../action-form";
import { createAgentTokenAction, type TokenState } from "../actions";

// Makes an agent token and shows it once, like NewTokenForm. The action is
// called directly rather than through useActionState, which would post the
// last result, plaintext token and all, back to the server on the next submit.
export function NewAgentTokenForm() {
  const [state, setState] = useState<TokenState>({});
  const [pending, start] = useTransition();
  // The form only sends through JavaScript; until then it cannot be sent.
  const hydrated = useHydrated();
  return (
    <>
      <form
        className="panel row"
        aria-busy={pending}
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          start(async () => {
            const next = await createAgentTokenAction({}, data);
            // Keep what was typed when it was refused.
            if (!next.error) form.reset();
            start(() => setState(next));
          });
        }}
      >
        <label>
          Agent name
          <input name="name" placeholder="Receipts agent" size={20} maxLength={80} required />
        </label>
        <label className="check">
          <input type="checkbox" name="permission" value="write" /> Can add, change and remove expenses
        </label>
        <button disabled={pending || !hydrated}>Make a token</button>
        {state.error && (
          <p role="alert" className="error">
            Not saved: {state.error}.
          </p>
        )}
      </form>
      {state.token && (
        <div className="panel" role="status">
          <p className="[overflow-wrap:anywhere]">
            <strong>Token for {state.name}.</strong> Copy it now: it is shown only this once.
          </p>
          <p>
            Token{" "}
            <code data-testid="new-agent-token" className="break-all select-all">
              {state.token}
            </code>
          </p>
        </div>
      )}
    </>
  );
}
