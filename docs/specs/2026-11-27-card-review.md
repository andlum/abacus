# Card review: log the payment, add only what you pick

## Status

**Decided 2026-11-27. Built 2026-11-27**, with the changes in "As built"
below. No question is open.

Decisions:

- **Question 1, 2026-11-27: the payment is a shared expense.** "B: a shared
  expense". This went against the recommendation (a record that counts for
  nothing). The whole payment is split by the usual rules, and each purchase
  added in a review is taken out of it and split its own way.
- **Question 2, 2026-11-27: payments are caught in the background.** "A: yes,
  in background". As recommended. The webhook and hourly job keep syncing a
  card, store its payments, and drop its purchases unstored.
- **Question 3, 2026-11-27: cards only.** "A: cards only". As recommended.
  Checking and savings accounts keep To sort as it worked before; only
  where it is shown moves (question 5).
- **Question 4, 2026-11-27: the review starts from a new Accounts section,
  not the Ledger.** "I don't want to add it from the ledger row because the
  ledger implies payments that've already been reviewed/set for split. I want
  a different entry point into this flow. This might be a useful new
  top-level section: 1. For each connected account, ability to review
  transactions and add expenses into the ledger". The Ledger row carries no
  link into the review.
- **Two uses, one flow.** Asked: "we have a shared credit card and I just
  want to record the payment. I imagine another use case is a user connects
  their credit card and they'll tag individual transactions. I want to make
  sure this works for btoh". Each card is marked shared or personal
  (section 1). Not yet confirmed as the answer.
- **Question 5, 2026-11-27: checking's To sort moves to Accounts too.**
  "Move it to Accounts". As recommended. Home shows no bank lists; a
  checking or savings account's To sort lives on its page in Accounts, and
  the nav item counts what is waiting there.
- **2026-11-27, at build: Abacus connects only credit cards.** "Cards only".
  `createLinkToken` asks Plaid for credit cards alone and `connectBank` keeps
  only `isCreditCard` accounts, so no checking or savings account can exist.
  Every part of this spec about them (questions 3 and 5, the "Checking 1111"
  row, the nav count, the to-sort count in the API) was not built.

## As built

What differs from the sections below:

- **No checking or savings parts.** See the last decision above.
- **To sort stays only for cards with "share every purchase" on.** Their
  purchases still arrive and are added on their own, and money in still
  waits in To sort. That list moves from Home to the card's page in
  Accounts. On every other card, a purchase untied from a recurring cost is
  set aside, not put back in To sort, so a review can pick it again.
- **The payment's expense is superseded, not corrected.** Taking purchases
  out makes a new version of the payment's expense with the smaller total
  (`createExpense` with `replaces`), as an edit does. No `expense_change`
  correction rows.
- **New cards start personal**, as existing ones do. The card's page asks.
- **The "Card payment" category is made the first time a group needs it**,
  not added to every group's defaults, so groups with no card never see it.
- **Only the start of a review can be widened** (`?from=`), back at most 730
  days and to what Plaid holds (90 days before the link). The end is the
  payment's date, or today on a personal card. The API takes no `to`.
- **A review with nothing picked is refused.** On a personal card that means
  `reviewedThrough` moves only when something is added.
- **What counts as a payment:** money in whose category is
  `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` or `TRANSFER_IN`. Other money in is a
  refund and is not stored. No name guessing.

Boards: [`docs/design/2026-11-27-card-review.html`](../design/2026-11-27-card-review.html)

## The ask

> I connected a credit card and it captured all of my expenses into a "To
> Sort" directory.
>
> Default should be just logging the credit card payment to the ledger. Users
> should be able to add certain expenses to the ledger as well, but that flow
> should look like:
>
> 1. Review transactions and select the ones you want to split
> 2. Of the ones you want to add to the ledger, how do you want to split them
> 3. Click submit => added to ledger

> By default though, it should not take up all of this real estate in the home
> screen. This flow should only grab transactions via Plaid via explicit user
> action

## Today

- **Every purchase lands in To sort.** `syncConnection` (`src/lib/bank.ts`,
  line 240) stores each posted USD transaction on a followed account as a
  `bank_transaction` in state `to_sort`, unless it ties to a recurring cost
  (`tryTie`) or the account has "share every purchase" on (`shareAll`,
  `autoAdd`). The first sync reaches back 30 days (`HISTORY_DAYS`).
- **Sync runs on its own.** Plaid's webhook (`applyPlaidWebhook`,
  `src/lib/bank-link.ts`), the hourly job (`runDailyJob`,
  `src/lib/daily-job.ts`) and a re-link all call it. The person does nothing.
- **Home shows all of it.** `BankToSort` (`src/app/home-bank.tsx`) is a card
  on Home with one row per waiting transaction, beside To do
  (`src/app/page.tsx`, line 113). A card with a month of purchases fills the
  page.
- **Sorting is one row at a time.** Each row is added (`addFromBank`: an
  expense the owner paid, split by the rules of its date, no choice of split),
  matched to a bill waiting for its amount (`matchBill`), or set aside
  (`dismissBankTransaction`).
- **The card payment is not usable.** Paying the card shows up on the card
  account as money in (a negative amount). `addFromBank` refuses it: "money
  coming in can only be set aside".
- **A one-off split exists, but not for bank rows.** A hand-entered expense
  can carry its own `rule` (`even`, `percent`, `fixed_plus_remainder`;
  `src/lib/expenses.ts`, line 47). The `bank` event cannot.

## What changes

Credit card accounts (`isCreditCard`) change the most (sections 1 to 4).
Every connected account, checking and savings included, gets a place in the
new Accounts section (section 5).

### 1. Each card is a shared card or a personal card

Asked once, right after a card is connected, and changeable on the card's
page in Accounts. A change applies to payments that post from then on.

- **Shared card.** A card the group uses together. Its payment is a shared
  expense (section 2). Reviewing is optional: it takes purchases out of a
  payment to split them another way.
- **Personal card.** One person's own card. Nothing on it is shared by
  default. Reviewing is how anything gets in: the purchases picked become
  expenses.

Cards connected before this ships start as personal, so nothing is shared
without its owner saying so. A card the group already uses together has to be
switched to shared once.

### 2. A shared card's payment is a shared expense

When a payment to a shared card posts, it becomes an expense: paid by the
card's owner, on the payment's date, for the payment's amount, split by the
rules in force that day, in the category "Card payment" (added to the seeded
categories, `src/lib/categories.ts`). Until the person reviews it, everything
on the card is shared the usual way.

Its Ledger row reads "Card payment · Visa 4242". It has no link into the
review: the Ledger holds what is already settled, and the review starts from
Accounts. Once purchases are taken out of it, the row says so: "$1,058.00 of
$1,200.00 · 3 purchases split separately".

**Taking a purchase out.** A purchase added in a review is split its own way,
and the payment it came from shrinks by the same amount. Abacus never edits a
saved expense, so the payment is superseded by a correction with the new
total (the `expense_change` `correction` kind). If purchases take out the
whole payment, it is voided with the reason "all of it split as purchases".
Purchases can never take out more than the payment; the review refuses it.

**Putting one back.** Voiding a purchase that was taken out of a payment adds
its amount back to that payment, by another correction.

**A personal card's payment** is stored too, with no expense. It shows only
on the card's page in Accounts: "Paid $900.00 on 18 Nov · not shared".

A payment is told apart from a refund by Plaid's category
(`personal_finance_category.detailed = LOAN_PAYMENTS_CREDIT_CARD_PAYMENT`).
A refund is not logged.

### 3. Purchases are fetched only when the person asks

Nothing stores a card's purchases on its own. The webhook and the hourly job
keep calling `transactions/sync` so payments are caught (question 2), but on
a card they save the payment and drop every purchase without storing it.

A review reads the card's purchases from Plaid at that moment with
`transactions/get`, for a date range that depends on the card:

- **Shared card:** a review is of one payment. The range runs from the day
  after the previous payment (or 30 days back, for the first) to the day of
  this payment. The review opens on the latest payment; a menu picks an
  earlier one. Purchases made since the latest payment wait for the next.
- **Personal card:** the range runs from the day after the card's
  `reviewedThrough` date (or 30 days back, the first time) to today, so a
  purchase can be shared the day after it is made.

Either range can be widened back as far as Plaid holds.

On a shared card, "since you last paid" is not the statement the payment
actually paid. A bank's statement closes some weeks before it is due, so the
two differ at the edges. That is why the range can be widened, and why the
only hard limit is that purchases cannot take out more than the payment.
Matching statements exactly needs Plaid's Liabilities product; this spec does
not use it.

### 4. The review: pick, split, submit

One page, `/accounts/[accountId]/review` (with `?payment=` on a shared card),
three steps. Nothing is saved until step 3.

**Step 1: Pick.** Every posted purchase in the range, newest first, each with
a checkbox. All start unticked, with one exception below. Shown but not
pickable: refunds and payments (money in), and purchases already added
(marked "Added", linking to their expense). The footer counts what is picked:
"3 picked · $142.00 of $1,200.00" on a shared card, "2 picked · $62.00" on a
personal one. Leaving with none picked changes nothing.

**Purchases already in the ledger.** A purchase that fits a recurring cost or
a bill waiting for its amount (today's `tryTie` and `billSuggestions`) says
"Already in the ledger as Internet". Ticked, it is tied to that cost, with no
new expense. On a shared card it starts ticked and is taken out of the
payment: left in, the same money is shared twice, once in the payment and
once as the recurring cost. On a personal card it starts unticked, since
nothing is counted twice.

**Step 2: Split.** One row per picked purchase: description (editable,
Plaid's name to start), category, and split. The split choices are:

- **Our usual split** (default): the rules in force on the purchase's date,
  as `addFromBank` does today.
- **Evenly**.
- **Custom**: percentages per member, which must add to 100.
- **All theirs / all mine**: for two people, 0/100 or 100/0. With more, a
  custom split.

A "Set all to" control above the rows applies one choice to every row. Each
row shows each member's share as it changes, from `POST /expenses/preview`.
In a business group, the card must first be marked personal or business
(today's `NEEDS_KIND` rule).

**Step 3: Submit.** A summary of every change, and one button. All of it goes
in or none does, in one database transaction. Each picked purchase becomes a
`bank_transaction` in state `added` and an expense the card's owner paid
(`kind: "bank"`, with the chosen `rule` when it is not the usual split). Then:

- **Shared card:** the button reads "Split 3 separately · $142.00", over "The
  card payment becomes $1,058.00". The payment is locked and superseded by
  its smaller total; each purchase records the payment it came from.
  Unpicked purchases stay inside the shared payment. Reopening the same
  payment shows them again, with the split ones marked "Added".
- **Personal card:** the button reads "Add 2 to the ledger · $62.00".
  `reviewedThrough` moves to the end of the range. Unpicked purchases are not
  stored and do not come back, unless the range is widened.

The person lands on the Ledger with the new rows marked.

### 5. Accounts: a new top-level section

A new item in the main navigation (`src/app/main-nav.tsx`): Home, Recurring
costs, **Accounts**, Activity, Settings. It appears only when the server has
Plaid keys (`bankRuntime()`). Connecting, re-linking and disconnecting a bank
stay in Settings → Bank; with nothing connected, Accounts says so and links
there.

**`/accounts`** lists the accounts the person connected, as To sort does
today (another member's connections are not shown). One row each:

- Shared card: "Visa 4242 · Shared card · Last payment 20 Nov, $1,200.00,
  $1,058.00 shared whole" and **Review transactions**.
- Personal card: "Visa 5555 · Personal card · Reviewed to 20 Nov" and
  **Review transactions**.
- Checking or savings: "Checking 1111 · 3 to sort" and **Sort**.

A card's row never counts its purchases: that would mean asking Plaid without
being asked. The nav item shows a count only for rows already waiting on a
checking or savings account.

**`/accounts/[accountId]`** is one account's page: the shared or personal
choice for a card, its payments with what is left of each, and **Review
transactions**. A checking or savings account's page holds its To sort and
Set aside lists, which move here from Home and work as they do today.

### 6. Home

- The To sort card is removed from Home, for every kind of account.
  `BankToSort` goes; the To do card takes the row alone.
- The relink notice stays: a broken connection needs the person to act.
- Nothing about reviewing is on Home.

### 7. What goes away for cards

- The To sort list and the Set aside list.
- "Share every purchase" (`shareAll`): it needs purchases to arrive on their
  own. The switch is hidden on cards. A card that has it on today keeps
  syncing as it does now until the person turns it off.

## Data

- `account.card_mode`: `shared` or `personal`, null for accounts that are not
  cards. Existing cards get `personal`.
- `account.reviewed_through`: the last day a personal card was reviewed to.
  Null until the first review.
- A new `card_payment` table: account, Plaid id (unique), date, amount paid,
  the card's mode when it posted, and the id of the expense that holds what
  is still shared (null on a personal card, and null once voided; it moves to
  the new row each time the expense is superseded). The amount paid never
  changes; the expense's total is the amount paid less the purchases taken
  out.
- `bank_transaction.card_payment_id`: the shared payment a purchase was taken
  out of, null for a personal card. Checked in the database: the purchases
  taken out of one payment never add up to more than it.
- `createExpense`'s `bank` event takes an optional `rule`, checked with
  `isValidRule` as the manual event is. A new `card_payment` event makes a
  shared payment's expense.
- The Ledger needs no new row type: a shared payment is an expense. It gains
  the "of $1,200.00" line from `card_payment`.
- **Rows waiting today.** Card rows in `to_sort` move to `dismissed`, with an
  audit entry `bank_transaction.cleared_for_review`. Nothing is lost: their
  purchases show again in the first review, read fresh from Plaid. Run
  `pnpm db:counts` before the migration to see how many.

## API, phone, agent

- `GET /api/v1/accounts`: the person's connected accounts, each with its
  kind, card mode, latest payment and what is left of it, reviewed-through
  date, and to-sort count (checking and savings only).
- `PATCH /api/v1/accounts/{id}`: `{ cardMode }`. Owner only.
- `GET /api/v1/accounts/{id}/review?payment=&from=&to=`: the range, the
  payment and what is left of it (shared card), and the purchases for step 1
  with `added` and suggestion fields. Owner only.
- `POST /api/v1/accounts/{id}/review`: `{ payment?, items: [{
  plaidTransactionId, description, category, rule?, tieTo? }] }`. Returns
  the expenses made, and on a shared card the payment's new expense. The
  server reads each item from Plaid again and refuses an id that is not on
  that card in that range, so a client cannot invent an amount.
- Both go in `src/lib/openapi.ts`, and `apps/ios/Abacus/Models.swift` by hand.
- `PlaidApi` (`src/lib/plaid.ts`) gains `transactionsGet`, and
  `src/lib/testing/fake-plaid.ts` with it.
- The MCP server does not get the review. An agent cannot pull card purchases.

## Tests

Written first, against PGlite and the fake Plaid:

- A sync on a card makes the payment's expense, split by the usual rules, and
  stores no purchase.
- A refund is not logged as a payment.
- A review of a $1,200.00 payment with three picked ($142.00) adds three
  expenses, each with its chosen split, and supersedes the payment with
  $1,058.00; the balance moves by exactly the difference in splits. A split
  that fails `isValidRule` adds none and leaves the payment as it was.
- Picking more than the payment is refused. Picking exactly all of it voids
  the payment.
- Voiding a purchase taken out of a payment puts its amount back.
- Reopening the review shows unpicked purchases again and the added ones as
  "Added".
- Submitting the same purchase twice (two tabs) adds it and takes it out once.
- Another member's card reads as not found.
- A personal card's payment makes no expense. A review of it adds the picks
  as new expenses, takes nothing out of anything, and moves
  `reviewedThrough` to the end of the range; the next review starts the day
  after.
- Switching a card from personal to shared leaves earlier payments as they
  were; the next payment is shared.
- `/accounts` lists only the person's own accounts, and calls Plaid for none
  of them (the fake Plaid counts calls).
- Playwright, shared: connect, mark the card shared, see one payment row in
  the Ledger with no review link, open Accounts, review, pick two, split one
  evenly, submit, see two expenses and the smaller payment.
- Playwright, personal: connect, leave it personal, see nothing in the
  Ledger, review from Accounts, pick one, submit, see one expense.

## Questions

1. **Decided: the payment is a shared expense.** See Status.
2. **Decided: payments are caught in the background.** See Status.
3. **Decided: cards only.** See Status.
4. **Decided: the review starts from Accounts.** See Status.
5. **Decided: checking's To sort moves to Accounts.** See Status.

## What could go wrong

- **A card marked wrong.** A personal card marked shared charges the partner
  a share of everything on it from the day the payment posts. A shared card
  left personal (the default for cards connected today) shares nothing, and
  the partner is never charged for it. The choice is asked at connect and
  shown on every row in Accounts, but nothing checks it.
- **Personal purchases on a shared card are shared until taken out.** Someone
  who pays for personal things on the shared card and never reviews charges
  the partner for them.
- **A personal card's review moves on.** Purchases left unticked are not
  shown again once `reviewedThrough` passes them. Widening the range brings
  them back, but nothing reminds anyone.
- **Recurring costs on the card are counted twice** until that payment is
  reviewed: once inside the payment, once as the recurring cost. The review
  ticks them by default, but nothing catches them before someone opens it.
- **"Since the last payment" is not the statement.** A purchase made just
  before a payment may have been on the next statement. Taking it out of this
  payment still balances in total over two payments, but one payment can end
  up smaller than what it really paid for.
- **The payment shows up twice when both ends are connected.** (Cannot
  happen while Abacus connects only cards; kept for if that changes.) With the
  checking account that pays the card also connected, the payment is a shared
  expense from the card and also an outflow in that account's To sort. Adding
  it there would share it twice. That row should say "Paid your Visa 4242:
  already shared as a card payment" and offer only Set aside. Matching it
  (same amount, within a few days, card in the same group) is not specified
  here.
- **Autopay of the full balance** is the easy case. A partial payment, or two
  payments in a month, makes each its own expense; purchases between them
  belong to the later one.

## Checked against Plaid's docs (2026-11-27)

- `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` is a real category ("payments made to a
  credit card account"). The docs do not say which category the card's side
  of a payment gets, so `TRANSFER_IN` also counts. Refunds have no category
  of their own; they keep the merchant's.
- `transactions/get` needs a start and end date, returns at most 500 a page
  with an offset, allows 30 calls a minute per Item, and answers
  `PRODUCT_NOT_READY` until Plaid's first pull is done (the review says to
  try again in a few minutes).
- Abacus never sets `days_requested`, so Plaid keeps its default of 90 days
  before the link. The 30 days in this spec are Abacus's own
  `HISTORY_DAYS`. It cannot be raised after linking without removing the
  Item.
- The docs call both ids "the unique ID" without saying they match. A
  pending purchase gets a new id when it posts; the review shows posted
  ones only. It matters only for cards that still share every purchase.
