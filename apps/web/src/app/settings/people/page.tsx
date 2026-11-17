import { listRuleHistory } from "@/lib/rules";
import { requireHousehold } from "@/lib/session";
import type { Rule } from "@abacus/core/split";
import { IncomeSection } from "../income-section";
import { PeopleSection } from "../people-section";
import { SettingsFrame } from "../settings-frame";
import { SplitSection } from "../split-section";

export const metadata = { title: "People · Settings · Clementine" };
export const dynamic = "force-dynamic";

const byIncome = (r: Rule) => r.kind === "income_proportional" || (r.kind === "fixed_plus_remainder" && r.remainder.kind === "income_proportional");

// Who is in the group and, once there is more than one person, how costs
// are shared between them. Incomes are for a household's split by income;
// a business sees them only while one of its rules still splits that way.
// `cover` preselects what a new split rule covers (split-section.tsx).
export default async function PeopleSettingsPage({ searchParams }: { searchParams: Promise<{ cover?: string }> }) {
  const { cover } = await searchParams;
  const ctx = await requireHousehold();
  const { db, me, home, members, today } = ctx;
  const shared = members.length > 1;
  const incomes =
    shared &&
    (home.kind === "household" ||
      (await listRuleHistory(db, me.householdId, today)).some((r) => (r.state === "current" || r.state === "upcoming") && byIncome(r.rule)));
  return (
    <SettingsFrame ctx={ctx}>
      <PeopleSection {...ctx} />
      {shared && <SplitSection {...ctx} cover={cover} />}
      {incomes && <IncomeSection {...ctx} />}
    </SettingsFrame>
  );
}
