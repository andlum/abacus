import { route } from "@/lib/api";
import { getBalance } from "@/lib/balance";
import { postDue } from "@/lib/expenses";
import { getOwedBack } from "@/lib/owed-back";

export const dynamic = "force-dynamic";

// A business also says what it owes the members who paid its costs on a
// personal account; a household's answer has no `owedBack`.
export const GET = route(async ({ db, home, today }) => {
  await postDue(db, home.id, today);
  const balance = await getBalance(db, home.id);
  const owedBack = await getOwedBack(db, home.id);
  return owedBack ? { ...balance, owedBack } : balance;
});
