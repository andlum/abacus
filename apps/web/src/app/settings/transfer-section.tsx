import type { requireHousehold } from "@/lib/session";
import { FinePrint } from "../ui";
import { ImportForm } from "./import-form";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;

// Expenses out as a CSV file, and back in from one.
export function TransferSection({ members, today }: Ctx) {
  return (
    <section aria-labelledby="transfer">
      <h2 id="transfer">Export and import</h2>
      <h3>Export expenses</h3>
      <p className="note">Split expenses and expenses that could not be split, as a CSV file. Payments are not included.</p>
      <form action="/settings/transfer/export" method="get" className="row">
        <label>
          From
          <input type="date" name="from" defaultValue={`${today.slice(0, 4)}-01-01`} required />
        </label>
        <label>
          To
          <input type="date" name="to" defaultValue={today} required />
        </label>
        <button>Download CSV</button>
      </form>

      <h3>Import expenses</h3>
      <p className="note">Every row is split again by the rules in force today.</p>
      <FinePrint>
        A row with an id replaces that expense, and the old one is kept as replaced. A row with a blank id is added. The
        share and status columns are ignored. Either every row is imported or none is. Payments are left alone.
      </FinePrint>
      <ImportForm people={members.map((m) => ({ id: m.id, displayName: m.displayName }))} />
    </section>
  );
}
