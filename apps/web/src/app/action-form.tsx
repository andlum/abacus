"use client";

import { startTransition, useActionState, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ActionState } from "@/lib/action";
import { toast } from "./toast";

type Props = {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  children: ReactNode;
  className?: string;
  // Asked before sending, for things that are hard to take back.
  confirm?: string;
  // Shown briefly once the action has worked: "Invite sent".
  done?: string;
  // Put the fields back to what the page showed when the action refuses,
  // for a form that changes a saved value rather than adds something.
  resetOnError?: boolean;
};

const noSubscribe = () => () => {};

// False in the server's HTML and until React has taken over the page, true
// after. A form whose submit only works through JavaScript keeps its button
// disabled until then, so a click that comes too early cannot send the
// fields to the address bar as a plain GET.
export function useHydrated() {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}

// Any form that worked tells the others on the page, so a refusal shown by
// a different form does not linger beside the new state of things.
const SUCCEEDED = "abacus:action-done";

// A form whose server action can answer with a message. What was typed
// stays in place when the action refuses it, and clears when it succeeds.
// The refusal's message goes as soon as the form is changed or sent again,
// or another form on the page succeeds.
//
// The action is also the form's `action`, so the server's HTML is a POST to
// it: a submit before the page has loaded still works, without JavaScript.
// A form that asks to `confirm` cannot ask before then, so it stays disabled
// until it can. While an action is running the form is disabled, so a
// double click sends once.
export function ActionForm({ action, children, className, confirm, done, resetOnError }: Props) {
  const [state, send, pending] = useActionState(action, {});
  const hydrated = useHydrated();
  // The answer whose message was put away.
  const [dismissed, setDismissed] = useState<typeof state | null>(null);
  const reset = useRef(resetOnError);
  useEffect(() => {
    reset.current = resetOnError;
  }, [resetOnError]);
  const ref = useRef<HTMLFormElement>(null);
  // True from sending until an answer comes back. An action that worked may
  // never answer here: it can send the browser to another page, or remove
  // the row this form sits in. Either way the form goes away while still
  // waiting, and that counts as done.
  const waiting = useRef(false);
  // Set on submit and cleared once the action is no longer running, so a
  // second click that lands before the form is disabled sends nothing.
  const sending = useRef(false);
  useEffect(() => {
    if (!pending) sending.current = false;
  }, [pending]);
  const message = useRef(done);
  useEffect(() => {
    message.current = done;
  }, [done]);
  useEffect(() => {
    if (!state.done && !state.error) return;
    waiting.current = false;
    if (state.done) {
      ref.current?.reset();
      if (message.current) toast(message.current);
      window.dispatchEvent(new Event(SUCCEEDED));
    } else if (reset.current) {
      ref.current?.reset();
    }
  }, [state]);
  useEffect(() => {
    const dismiss = () => setDismissed(state);
    window.addEventListener(SUCCEEDED, dismiss);
    return () => window.removeEventListener(SUCCEEDED, dismiss);
  }, [state]);
  useEffect(
    () => () => {
      if (!waiting.current) return;
      if (message.current) toast(message.current);
      window.dispatchEvent(new Event(SUCCEEDED));
    },
    [],
  );
  return (
    <form
      ref={ref}
      action={send}
      className={className}
      aria-busy={pending}
      onChange={() => setDismissed(state)}
      onSubmit={(e) => {
        // Sent from here rather than by React's form action, which would
        // clear what was typed even when the action refuses it.
        e.preventDefault();
        if (sending.current) return;
        if (confirm && !window.confirm(confirm)) return;
        sending.current = true;
        const data = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
        waiting.current = true;
        setDismissed(state);
        startTransition(() => send(data));
      }}
    >
      <fieldset disabled={pending || (!!confirm && !hydrated)} className="contents">
        {children}
      </fieldset>
      {state.error && dismissed !== state && (
        <p role="alert" className="error">
          Not saved: {state.error}.
        </p>
      )}
    </form>
  );
}
