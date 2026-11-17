import { listMcpTokens } from "@/lib/mcp-tokens";
import { siteAddress } from "@/lib/site";
import type { requireHousehold } from "@/lib/session";
import { ActionForm } from "../action-form";
import { revokeAgentTokenAction } from "../actions";
import { NewAgentTokenForm } from "./new-agent-token-form";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;

const may = { read: "Read only", propose: "Read only", write: "Read, and add, change and remove expenses" } as const;

const when = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

// The tokens an agent uses, for this group only. Kept apart from devices,
// which act with the person's full rights.
export async function AgentsSection({ me, home, db }: Ctx) {
  const tokens = await listMcpTokens(db, me);
  const endpoint = `${await siteAddress()}/api/mcp`;

  return (
    <section aria-labelledby="agents" className="mb-10">
      <h2 id="agents">Agents</h2>
      <p className="note">
        An agent token lets an assistant read the expenses and the balance of {home.name}. It reaches this group only. If
        you tick &ldquo;Can add, change and remove expenses&rdquo;, it can also do those for you: they count at once, and
        Activity shows them as your agent&rsquo;s. Otherwise it only reads.
      </p>
      <p className="note">
        Give your MCP client the address <code>{endpoint}</code> and the header{" "}
        <code>Authorization: Bearer</code> followed by the token. In Claude Code:
      </p>
      <pre className="overflow-x-auto">
        <code>{`claude mcp add --transport http abacus ${endpoint} \\\n  --header "Authorization: Bearer abm_..."`}</code>
      </pre>
      <NewAgentTokenForm />

      {tokens.length > 0 && (
        <>
          <h3>Your agents</h3>
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>May</th>
                <th>Made</th>
                <th>Last used</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} className={t.revokedAt ? "gone" : undefined}>
                  <td className="whitespace-normal [overflow-wrap:anywhere]">{t.name}</td>
                  <td>{may[t.permission]}</td>
                  <td className="whitespace-nowrap">{when.format(t.createdAt)}</td>
                  <td className="whitespace-nowrap">{t.lastUsedAt ? when.format(t.lastUsedAt) : "never"}</td>
                  <td>
                    {t.revokedAt ? (
                      <span className="tag">revoked {when.format(t.revokedAt)}</span>
                    ) : (
                      <span className="tag ok">active</span>
                    )}
                  </td>
                  <td>
                    {!t.revokedAt && (
                      <ActionForm action={revokeAgentTokenAction} done="Agent token revoked" className="inline" confirm={`Revoke ${t.name}? It stops working at once.`}>
                        <input type="hidden" name="tokenId" value={t.id} />
                        <button className="danger">Revoke</button>
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
