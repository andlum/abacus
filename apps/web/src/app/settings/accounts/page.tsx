import { requireHousehold } from "@/lib/session";
import { AccountsSection } from "../accounts-section";
import { SettingsFrame } from "../settings-frame";

export const metadata = { title: "Connected accounts · Settings · Clementine" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const ctx = await requireHousehold();
  return (
    <SettingsFrame ctx={ctx}>
      <AccountsSection {...ctx} />
    </SettingsFrame>
  );
}
