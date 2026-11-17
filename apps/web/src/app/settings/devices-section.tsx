import { headers } from "next/headers";
import { FinePrint } from "../ui";
import { listApiTokens } from "@/lib/api-tokens";
import type { requireHousehold } from "@/lib/session";
import { ActionForm } from "../action-form";
import { revokeTokenAction } from "../actions";
import { NewTokenForm } from "./new-token-form";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;

const when = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

// The tokens that let a phone or a script act as the person looking.
export async function DevicesSection({ me, db }: Ctx) {
  const tokens = await listApiTokens(db, me.id);
  const h = await headers();
  const server = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;

  return (
    <section aria-labelledby="devices" className="mb-10">
      <h2 id="devices">Phone app and scripts</h2>
      <p className="note">A device token lets the Clementine phone app, or a script you write, act as you.</p>
      <FinePrint>
        It can see everything you see and add or void expenses and payments. Give each device its own token, and
        disconnect any device you lose. Only you see your tokens.
      </FinePrint>
      <NewTokenForm server={server} />

      {tokens.length > 0 && (
        <>
          <h3>Your devices</h3>
          <table>
            <thead>
              <tr>
                <th>Device</th>
                <th>Connected</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} className={t.revokedAt ? "gone" : undefined}>
                  <td>{t.name}</td>
                  <td className="whitespace-nowrap">{when.format(t.createdAt)}</td>
                  <td>
                    {t.revokedAt ? (
                      <span className="tag">disconnected {when.format(t.revokedAt)}</span>
                    ) : (
                      <span className="tag ok">active</span>
                    )}
                  </td>
                  <td>
                    {!t.revokedAt && (
                      <ActionForm action={revokeTokenAction} done="Device disconnected" className="inline" confirm={`Disconnect ${t.name}? It stops working at once.`}>
                        <input type="hidden" name="tokenId" value={t.id} />
                        <button className="danger">Disconnect</button>
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
