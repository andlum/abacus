import { memberJson, route } from "@/lib/api";
import { listAccounts } from "@/lib/accounts";
import { listCategories } from "@/lib/categories";

export const dynamic = "force-dynamic";

// Who the token acts for, their household, its members, its categories and
// its accounts.
export const GET = route(async ({ me, db, home, members, today }) => ({
  me: { ...memberJson(me), email: me.email },
  household: { id: home.id, name: home.name, kind: home.kind, timezone: home.timezone },
  members: members.map(memberJson),
  categories: (await listCategories(db, home.id)).map((c) => ({ slug: c.slug, label: c.label })),
  // Archived ones too, since older expenses name them; not offered for new.
  accounts: (await listAccounts(db, home.id, { archived: true })).map((a) => ({
    id: a.id,
    name: a.name,
    lastFour: a.lastFour,
    kind: a.kind,
    archived: a.archivedAt !== null,
  })),
  today,
}));
