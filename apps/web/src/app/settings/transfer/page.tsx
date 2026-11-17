import { requireHousehold } from "@/lib/session";
import { SettingsFrame } from "../settings-frame";
import { TransferSection } from "../transfer-section";

export const metadata = { title: "Export and import · Settings · Clementine" };
export const dynamic = "force-dynamic";

export default async function TransferSettingsPage() {
  const ctx = await requireHousehold();
  return (
    <SettingsFrame ctx={ctx}>
      <TransferSection {...ctx} />
    </SettingsFrame>
  );
}
