"use client";

import { useActionState, useTransition } from "react";
import { useHydrated } from "../action-form";
import { createTokenAction, type TokenState } from "../actions";

// Makes a token and shows it once. Leaving or reloading the page loses it;
// the person makes another.
export function NewTokenForm({ server }: { server: string }) {
  const [state, send] = useActionState<TokenState, FormData>(createTokenAction, {});
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
          const data = new FormData(e.currentTarget);
          e.currentTarget.reset();
          start(() => send(data));
        }}
      >
        <label>
          Device name
          <input name="name" placeholder="Alex's iPhone" size={20} required />
        </label>
        <button disabled={pending || !hydrated}>Connect a device</button>
        {state.error && (
          <p role="alert" className="error">
            Not saved: {state.error}.
          </p>
        )}
      </form>
      {state.token && (
        <div className="panel" role="status">
          <p>
            <strong>Token for {state.name}.</strong> Copy it now: it is shown only this once.
          </p>
          <p>
            Server <code>{server}</code>
          </p>
          <p>
            Token{" "}
            <code data-testid="new-token" className="break-all select-all">
              {state.token}
            </code>
          </p>
        </div>
      )}
    </>
  );
}
