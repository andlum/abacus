import { ACCOUNT_KINDS, type AccountKind } from "@/db/schema";
import { KIND_LABELS, MAX_ACCOUNT_NAME } from "@/lib/accounts";
import type { requireHousehold } from "@/lib/session";
import { ActionForm } from "../action-form";
import { BankConnections } from "./bank-section";
import { accountText, FinePrint } from "../ui";
import {
  addAccountAction,
  archiveAccountAction,
  renameAccountAction,
  restoreAccountAction,
  setAccountKindAction,
} from "../actions";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;

function KindSelect({ value, label }: { value?: AccountKind | null; label: string }) {
  return (
    <select name="kind" defaultValue={value ?? ""} aria-label={label} required>
      {!value && (
        <option value="" disabled>
          Personal or business?
        </option>
      )}
      {ACCOUNT_KINDS.map((k) => (
        <option key={k} value={k}>
          {KIND_LABELS[k]}
        </option>
      ))}
    </select>
  );
}

// The cards and accounts a cost can be paid from. In a business group each
// says whether it is the owner's own or the business's.
export function AccountsSection(ctx: Ctx) {
  const { home, accounts } = ctx;
  const business = home.kind === "business";
  const active = accounts.filter((a) => !a.archivedAt);
  const archived = accounts.filter((a) => a.archivedAt);
  return (
    <section aria-labelledby="accounts" className="mb-10">
      <h2 id="accounts">Connected accounts</h2>
      <p className="note">The cards and accounts {home.name} pays from, so each cost can say which one paid.</p>
      <FinePrint>
        {business && "Mark each as personal or business, so you can tell which costs went on your own card. "}The last
        four digits only tell two cards apart; never enter a whole card number. Archiving an account takes it off the
        list for new costs; costs already paid from it keep it.
      </FinePrint>
      <BankConnections {...ctx} />
      {active.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {active.map((a) => (
              <tr key={a.id}>
                <td>
                  <ActionForm action={renameAccountAction} done="Saved" className="row">
                    <input type="hidden" name="accountId" value={a.id} />
                    <input
                      name="name"
                      defaultValue={a.name}
                      aria-label={`Name of ${a.name}`}
                      maxLength={MAX_ACCOUNT_NAME}
                      required
                    />
                    <input
                      name="lastFour"
                      defaultValue={a.lastFour ?? ""}
                      aria-label={`Last four digits of ${a.name}`}
                      inputMode="numeric"
                      pattern="[0-9]{4}"
                      maxLength={4}
                      size={4}
                    />
                    <button>Save</button>
                  </ActionForm>
                  {business && (
                    <ActionForm action={setAccountKindAction} done="Saved" className="row" resetOnError>
                      <input type="hidden" name="accountId" value={a.id} />
                      <KindSelect value={a.kind} label={`Whose money ${a.name} is`} />
                      <button className="quiet">Set</button>
                    </ActionForm>
                  )}
                </td>
                <td>
                  <ActionForm action={archiveAccountAction} done="Archived">
                    <input type="hidden" name="accountId" value={a.id} />
                    <button className="quiet">Archive</button>
                  </ActionForm>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ActionForm action={addAccountAction} done="Added" className="row">
        <label>
          New account
          <input name="name" maxLength={MAX_ACCOUNT_NAME} placeholder="Joint card" required />
        </label>
        <label>
          Last four digits (optional)
          <input name="lastFour" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} size={4} />
        </label>
        {business && (
          <label>
            Kind
            <KindSelect label="Personal or business" />
          </label>
        )}
        <button>Add account</button>
      </ActionForm>
      {archived.length > 0 && (
        <>
          <h3>Archived</h3>
          <ul>
            {archived.map((a) => (
              <li key={a.id}>
                <ActionForm action={restoreAccountAction} done="Restored" className="row">
                  <input type="hidden" name="accountId" value={a.id} />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{accountText(a)}</span>
                  <button className="quiet">Restore</button>
                </ActionForm>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
