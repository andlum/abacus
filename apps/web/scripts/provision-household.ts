// Creates the household and its two member rows. Run once per database.
// Names and emails come from the environment so they stay out of the repo:
//   HOUSEHOLD_NAME, HOUSEHOLD_TIMEZONE, MEMBER_1_NAME, MEMBER_1_EMAIL,
//   MEMBER_2_NAME, MEMBER_2_EMAIL
import { connect } from "../src/db/client.ts";
import { household, member } from "../src/db/schema.ts";
import { writeAudit } from "../src/lib/audit.ts";
import { seedCategories } from "../src/lib/categories.ts";
import { isTimezone } from "@abacus/core/dates";

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`missing ${name}`);
    process.exit(1);
  }
  return v;
}

const householdName = need("HOUSEHOLD_NAME");
// Decides which day "today" is, and so when recurring costs fall due.
const timezone = need("HOUSEHOLD_TIMEZONE");
if (!isTimezone(timezone)) {
  console.error(`HOUSEHOLD_TIMEZONE must be a timezone name like America/New_York, not "${timezone}"`);
  process.exit(1);
}
const people = [1, 2].map((n) => ({
  displayName: need(`MEMBER_${n}_NAME`),
  email: need(`MEMBER_${n}_EMAIL`).toLowerCase(),
}));

const { db, pool } = connect();

const existing = await db.select().from(household);
if (existing.length > 0) {
  console.error("a household already exists; nothing changed");
  await pool.end();
  process.exit(1);
}

await db.transaction(async (tx) => {
  const [h] = await tx.insert(household).values({ name: householdName, timezone }).returning();
  await seedCategories(tx, h!.id, "household");
  const rows = await tx
    .insert(member)
    .values(people.map((p) => ({ ...p, householdId: h!.id })))
    .returning();
  await writeAudit(tx, {
    householdId: h!.id,
    actor: { kind: "system" },
    action: "household.provisioned",
    entity: { type: "household", id: h!.id },
    detail: { memberIds: rows.map((r) => r.id) },
  });
});

await pool.end();
console.log(`provisioned household with ${people.length} members`);
