import { requireHousehold } from "@/lib/session";
import { AgentsSection } from "../agents-section";
import { DevicesSection } from "../devices-section";
import { SettingsFrame } from "../settings-frame";

export const metadata = { title: "Agents · Settings · Clementine" };
export const dynamic = "force-dynamic";

// Everything that can act for the person looking: agents through MCP, and
// the phone app or a script through a device token.
export default async function AgentsSettingsPage() {
  const ctx = await requireHousehold();
  return (
    <SettingsFrame ctx={ctx}>
      <AgentsSection {...ctx} />
      <DevicesSection {...ctx} />
    </SettingsFrame>
  );
}
