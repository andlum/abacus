import Link from "next/link";
import { notFound } from "next/navigation";
import { UserError } from "@abacus/core/errors";
import { DEFAULT_CATEGORY } from "@/db/schema";
import { bankRuntime } from "@/lib/bank-link";
import { cardAccount, getReview } from "@/lib/card-review";
import { requireHousehold } from "@/lib/session";
import { LinkButton, Shell } from "../../../ui";
import { cardName } from "../../card-text";
import { ReviewFlow } from "./review-flow";

export const dynamic = "force-dynamic";

type Search = { payment?: string | string[]; from?: string | string[] };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

// Reads the card's purchases from the bank, only now that its owner asked.
export default async function ReviewPage({ params, searchParams }: { params: Promise<{ accountId: string }>; searchParams: Promise<Search> }) {
  const bank = bankRuntime();
  if (!bank) notFound();
  const { accountId } = await params;
  const raw = await searchParams;
  const payment = first(raw.payment);
  const from = first(raw.from);
  const ctx = await requireHousehold();
  const { me, db, members, categories, today } = ctx;

  let review;
  try {
    review = await getReview(db, bank, me, accountId, { payment, from }, new Date());
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    // A shared card with no shared payment: earlier ones can be shared by hand.
    const earlier = await cardAccount(db, me, accountId).then((c) => c.cardMode === "shared" && !c.shareAll && !c.payments.some((p) => p.mode === "shared"), () => false);
    return (
      <Shell {...ctx} title="Review transactions">
        <p role="alert" className="text-destructive">
          {e.message[0]!.toUpperCase() + e.message.slice(1)}.
        </p>
        <p>
          <LinkButton href={`/accounts/${accountId}`} variant="outline" size="sm">
            Back to the card
          </LinkButton>
          {earlier && (
            <>
              {" "}
              <LinkButton href={`/accounts/${accountId}/payments`} variant="outline" size="sm">
                Find earlier payments
              </LinkButton>
            </>
          )}
        </p>
      </Shell>
    );
  }

  return (
    <Shell {...ctx} title={`Review ${cardName(review.account)}`}>
      <p className="note mt-0">
        <Link href={`/accounts/${review.account.id}`}>Back to the card</Link>
      </p>
      <ReviewFlow
        key={`${review.payment?.id ?? ""}|${review.from}`}
        review={review}
        fromParam={from}
        meId={me.id}
        members={members.map((m) => ({ id: m.id, displayName: m.displayName }))}
        categories={categories.filter((c) => !c.removedAt).map((c) => ({ slug: c.slug, label: c.label }))}
        defaultCategory={DEFAULT_CATEGORY}
        today={today}
      />
    </Shell>
  );
}
