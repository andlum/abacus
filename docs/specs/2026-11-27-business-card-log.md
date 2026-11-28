# Business card log: pick, label, log

## Status

**Draft, 2026-11-27. Not built.** Question 4 is open; it belongs to stage 2, so stage 1 can be built.

Decisions:

- **Question 1, 2026-11-27: a business card's review starts with every
  purchase ticked.** "Ticked by default". As recommended. Purchases are still
  fetched only when the person opens a review; nothing is logged in the
  background.
- **Question 6, 2026-11-27: the review and the tax fields ship together.**
  "Stages 1 and 2 together". This went against the recommendation (the
  review alone first). Every expense logged from a review has a vendor, a
  note, a business-use share and a category with a tax line from the first
  day, so nothing is filled in afterwards. The review stays as it is until
  all of it is ready.
- **Question 2, 2026-11-27: every business group gets this review.** "Yes,
  all businesses". As recommended. A business with two or more members sees
  the split controls in step 2; no business group logs a card payment as an
  expense or is asked "Shared or personal".
- **Question 3, 2026-11-27: card payments already logged are left.** "Leave
  them". As recommended. A business group's existing "Card payment" expenses
  stay as they are and no balance moves. The card's page says that payments
  before the change were logged whole, "Card payment" gets no tax line, and
  the year view shows it apart from costs.
- **Question 5, 2026-11-27: the business owes back only the business part.**
  "business part only". As recommended. A $100.00 bill paid on a personal
  card and marked 50% business adds $50.00 to what the business owes its
  owner. The expense keeps its whole amount.

## The ask

> I need to refine the workflow of connecting business accounts. I'm a single
> member LLC. I shouldn't have a split workflow for these expenses. This is
> more a centralized log of all my expenses as a business (so that I know how
> much to claim from my taxes in the future).

The card review ([2026-11-27-card-review.md](2026-11-27-card-review.md)) was
written for a household: who owes whom for a purchase. A one-person business
asks something else: is this purchase the business's, what kind of cost is
it, and can I show that later. This spec changes the review for business
groups. A household's review stays as it is.

## Today

- **The Split step has nothing to split.** `review-flow.tsx` always shows
  Pick, Split, Submit. With one member the choices are "Our usual split",
  "Evenly" and "Custom", and each gives that member 100%. The summary reads
  "Hosting, evenly".
- **The account's kind is asked too late, and somewhere else.** A business
  group's account must be marked personal or business before anything is
  added from it (`NEEDS_KIND`, `src/lib/bank.ts`). The review checks this
  only at submit (`submitReview`, `src/lib/card-review.ts`), so the person
  picks and labels everything and then reads "first say whether this account
  is personal or business". The control is in Settings → Accounts
  (`settings/accounts-section.tsx`). Neither the card's page nor the review
  has it or links to it.
- **Two switches that sound alike.** The card's page asks "Shared or
  personal" (`card_mode`: is the payment split with the group). Settings asks
  "Personal or business" (`kind`: whose money it is). In a one-person
  business only the second means anything.
- **A shared card logs the payment.** Its payment becomes an expense in the
  category "Card payment". For a business's books the payment is money moving
  between accounts; the purchases are the costs.
- **Refunds are not stored.** Money in that is not a payment is dropped, so a
  refunded purchase stays in the total at full price.
- **An expense holds little.** Date, description, category, account, amount.
  No vendor, no note, no say of how much of it was for the business, no
  receipt.
- **Categories are a short starter list.** A business group starts with
  Software, Travel, Meals, Fees and Other (`DEFAULT_CATEGORIES`,
  `src/lib/categories.ts`). Nothing says where a category goes on a tax
  form.
- **No total by category.** The Ledger filters by account and by personal
  and business. Nothing adds a year up.

## What changes

In a business group only, unless a section says otherwise.

### 1. Personal or business is asked on the card's page

The card's page in Accounts (`/accounts/[accountId]`) asks "Whose card is
this?" with two choices, in place of "Shared or personal":

- **Business card.** The business's own card. Purchases on it are the
  business's unless the person says otherwise.
- **Personal card.** The person's own card. Purchases on it are personal
  unless the person picks them. One picked is a cost the business owes the
  person back (`owed-back.ts`, as today).

Until it is answered, **Review transactions** is replaced by the question.
The review can no longer be opened on a card with no kind, so the error in
"Today" cannot happen at submit. The rule that a kind is fixed once anything
is paid from the account stays; the page says so beside the choice.

`card_mode` is not asked in a business group. Its cards behave as `personal`
cards do today: the payment is stored and makes no expense. This holds for a
business with two people too (question 2): to split a card's costs they log
its purchases.

### 2. The review is Pick, Label, Log

Same page, same three steps, nothing saved until the last.

**Step 1: Pick.** As today, with one change: on a business card every
purchase starts ticked, and the person unticks what was personal. On a
personal card every purchase starts unticked. The footer on a business card
reads "14 of 16 are business · $1,180.00", on a personal card "2 picked ·
$62.00". Purchases that fit a recurring cost still say "Already in the ledger
as Internet" and tie to it.

**Step 2: Label.** One row per picked purchase: description, category, and a
note that is empty by default. No split controls when the group has one
member. A "Set all to" control sets one category on every row. Where the
group has seen the merchant before, the category starts as the one used last
time (section 3).

**Step 3: Log.** The summary lists each purchase with its category. The
button reads "Log 14 · $1,180.00". Each becomes an expense the card's owner
paid, from this account, as `submitReview` does today, with no `rule`.
`reviewedThrough` moves to the end of the range.

**Hiding the split is about the number of members, not the kind of group.**
Any group with one member skips the split controls. A business with two
members keeps them (question 2).

### 3. The category is remembered by merchant

When a purchase is logged, the group remembers the category chosen for its
merchant (Plaid's `merchant_name`, or the cleaned-up name when there is
none). The next review starts that merchant's rows in that category. The
person can change it on the row, and the newest choice wins. Nothing is
logged from this by itself: it only fills in step 2.

### 4. What an expense can say

- **Vendor.** Who was paid, kept apart from the description. Plaid's merchant
  name to start.
- **Note.** Free text: what it was for.
- **Business use.** A percentage, 100% unless changed, with a required
  one-line reason when it is less ("phone: half the calls are clients"). The
  amount stays the whole purchase; reports count the business part.
- **Receipt.** A file attached to the expense. Last, and its own spec:
  it needs file storage, which Abacus does not have.

### 5. Categories that map to the tax form

A category gains two optional fields: the line it reports on (text, so "24b"
and "27a" fit) and whether it is meals, which count at half. A new business
group starts with a longer list that follows Schedule C, part II:

Advertising (8), Car and truck (9), Commissions and fees (10), Contract labor
(11), Insurance (15), Legal and professional (17), Office expense (18), Rent
(20b), Repairs (21), Supplies (22), Taxes and licenses (23), Travel (24a),
Meals (24b), Utilities (25), Software and subscriptions (27a), Other.

Line numbers are checked against the current year's form before this is
built. A group can still add, rename and remove categories, and set the line
on its own. Groups that exist keep the categories they have; Settings offers
to add the ones they lack.

### 6. Refunds (stage 2)

Money in on a card that is not a payment shows in the review as a refund and
can be picked. Logged, it lowers the total of its category for the year. How
it is stored is question 4: `expense.total_cents` must be above zero today.

### 7. The year view (stage 2)

A page in a business group: for a chosen year, the total per category with
its line, meals at half, the business part of anything under 100%, and what
was paid from personal accounts. The same as a CSV. This is a summary for the
person and their accountant; Abacus does not prepare a return.

## Stages

1. **The review and what an expense can say** (sections 1 to 5, without
   receipts), in one release (question 6). Step 2 of the review shows the
   vendor, the note and the business-use share beside the category. Schema,
   API, OpenAPI spec and the iOS models change.
2. **Refunds and the year view** (sections 6 and 7).
3. **Receipts.** Its own spec.

## Data

- A new `merchant_category` table: group, merchant key, category slug, when
  it was last used. One row per group and merchant.
- No change to `account`: `kind` exists. `card_mode` stays `personal` on a
  business group's cards and is not shown.
- `expense`: `vendor` (text), `note` (text), `business_use_bp` (basis points,
  default 10000), `use_basis` (text, required when below 10000).
- `category`: `tax_line` (text, null), `half_deductible` (boolean).
- `owed-back.ts` adds up each expense's total times its `business_use_bp`,
  rounded to the cent per expense, where it adds whole totals today. `GET
  /balance` (`owedBack`) and the MCP `get_balance` tool return that figure.

## API, phone, agent

- `GET /api/v1/accounts/{id}/review` gains, per line, `picked` (the starting
  tick) and `category` (the remembered one, or the group's default).
- `POST /api/v1/accounts/{id}/review` adds `vendor`, `note`, `businessUseBp` and `useBasis` to an item, and the same
  fields to an expense everywhere it is read or written.
- `PATCH /api/v1/accounts/{id}` takes `{ kind }` in a business group.
- All of it goes in `src/lib/openapi.ts`, and `apps/ios/Abacus/Models.swift`
  by hand.
- The MCP read tools return the new expense and category fields, so an agent
  can add a year up. The review stays out of MCP.

## Tests

Written first, against PGlite and the fake Plaid:

- In a business group, a card with no kind cannot open a review, by page or
  by API; once marked, it can.
- A business card's review returns every purchase with `picked: true`; a
  personal card's with `picked: false`.
- Logging 14 of 16 on a business card adds 14 expenses with no rule, each
  100% the owner's, and moves `reviewedThrough`. The two left out do not
  come back unless the range is widened.
- A purchase picked on a personal card counts in what the business owes its
  owner; one on a business card does not.
- A $100.00 purchase on a personal card at 50% business adds $50.00 to what
  the business owes its owner; the expense still reads $100.00. Below 100%
  with no reason is refused.
- A merchant logged as Software starts as Software in the next review; a
  different choice replaces it.
- A business group's card payment makes no expense, whatever `card_mode`
  says.
- A group with two members still gets split controls. A household with one
  member does not.
- Playwright: make a one-person business, connect a card, mark it business,
  review, untick one, set a category, log, see the expenses in the Ledger.

## Questions

1. **Decided: ticked by default.** See Status.
2. **Decided: every business group gets this review.** See Status.
3. **Decided: card payments already logged are left.** See Status.
4. **How a refund is stored.** A negative expense (loosens the
   `expense_total` check, and every sum must cope), or its own row type tied
   to a category. Recommended: its own row type.
5. **Decided: the business owes back only the business part.** See Status.
6. **Decided: the review and the tax fields ship together.** See Status.

## What could go wrong

- **A personal purchase left ticked** is logged as a business cost. Ticking
  everything makes this the likely mistake on a business card; the footer
  count and the summary are the only checks. Voiding the expense undoes it.
- **A business purchase left unticked does not come back.** As on a personal
  card today, `reviewedThrough` passes it. Widening the range shows it again.
- **Not reviewing logs nothing.** Nothing reminds anyone, so a year can end
  with months missing. The card's row in Accounts shows "Reviewed to 27 Nov",
  and that is all.
- **A remembered category can be wrong for years.** One early mislabel
  repeats until someone changes it.
- **This reverses part of the card review.** In a business group the
  shared-or-personal choice goes away the day after it shipped, and a shared
  card stops logging its payment. A two-person business can no longer
  split a whole card payment in one go.
- **An old payment and its purchases can both be in the ledger.** A card
  payment logged before this change stays (question 3). Reviewing purchases
  from the same weeks logs that money again, and nothing takes it out of the
  old payment. The card's page says so; voiding the old payment by hand is
  the fix.
- **The tax lines are a guide.** Which line a cost belongs on, and how much
  of it counts, is the filer's call. The form's line numbers can change from
  year to year.
- **Stage 1 changes the API's expense shape.** The phone must be updated in
  the same release or it drops the new fields on an edit.
