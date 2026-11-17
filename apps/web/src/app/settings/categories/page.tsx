import { requireHousehold } from "@/lib/session";
import { CategoriesSection } from "../categories-section";
import { SettingsFrame } from "../settings-frame";

export const metadata = { title: "Categories · Settings · Clementine" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const ctx = await requireHousehold();
  return (
    <SettingsFrame ctx={ctx}>
      <CategoriesSection {...ctx} />
    </SettingsFrame>
  );
}
