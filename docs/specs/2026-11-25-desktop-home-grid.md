# Desktop Home: a smaller balance and a grid

## Status

**Draft**, 2026-11-25. No decisions recorded yet.

Boards: [`docs/design/2026-11-25-desktop-home-grid.html`](../design/2026-11-25-desktop-home-grid.html)

## The complaint

> Feature for Abacus/Clementine. I want to make the desktop homescreen more
> space-effecive. This stacked display makes sense for mobile, but it should be
> a grid on desktop. The balance takes up WAY too much screen real estate. It
> should be much smaller, just a detail, not a hero. PLease draw a few
> alternative boards for this

It came with a screenshot of Home in a window about 1000px wide, dark theme,
nothing in To do and no bank connected. The screenshot is not in this
repository because it shows real figures; the boards redraw it with Alex and
Sam.

## Today

Home is `apps/web/src/app/page.tsx`. It renders these, top to bottom, inside
the shared `Shell` (`ui.tsx`), which caps every page at `max-w-5xl` (1024px):

| What | Where | What it does on a desktop |
| --- | --- | --- |
| Title row | `Shell` in `ui.tsx` | "Home" in 36px Fraunces. "Paid personally" and "Getting started" buttons sit at its right, only when they apply. |
| Balance card | `home-balance.tsx` | A full-width card: the label "Balance", then one 36px Fraunces line per debt ("Sam owes Alex $1,440.00"), then a folded "How the balance adds up" bar. About 190px tall in the screenshot. Two notes can appear under the headline: "Not counted yet: N expenses waiting in To do", and the business note about personal accounts. |
| To do card | `home-todo.tsx` | Rendered only when something waits. It then sits **beside** the balance: `page.tsx` switches to `sm:grid-cols-2`. This is the only grid on the page. |
| To sort card | `home-bank.tsx` | Full width under those, only with a bank connected. |
| Ledger | `ledger-view.tsx` | Heading and "This month" button, the folded Filters bar, a one-line count ("Last 30 days: 3 expenses · $5,480.00 · 1 payment"), then the table. Below 640px the table becomes a list of cards. |

Why it is this way: the page was written as one column, and the balance was
given the `.headline` style (`globals.css`), the same one page titles use, on
the reasoning that who owes whom is the first thing someone opens the app for.
All of this dates from the initial commit; no ticket argues for it. The only
desktop-specific layout is the balance and To do sharing a row. With nothing in
To do, which is the usual state, the balance card stretches across all 976px
to hold one sentence.

Measured from the screenshot (2000px wide at 2x): the first ledger row starts
about 465px down the page content. The balance card and its margins are about
225px of that.

## The same in every approach

- **Phones do not change.** Below the desktop breakpoint (question 2) Home
  stays stacked as it is. The iOS app is not touched.
- **No data changes.** No migration, no API change, no new query. The balance
  is still `getBalance`, the ledger still `LedgerView`.
- **The balance sentence keeps its words:** "Sam owes Alex $1,440.00", one line
  per debt, or "You are all square."
- **The balance stops being a headline.** It is no longer set in the 36px
  title style on a desktop.
- **Nothing is lost.** "How the balance adds up" (the table and "See payments
  in the Ledger"), the "Not counted yet" note and the business note are all
  still reachable from the balance, and the balance is still a region named
  "Balance" for screen readers and the Playwright story.
- **To do and To sort keep their contents** and still appear only when they
  have something to show.
- **The Ledger keeps** its filters, month view, paging and columns.
- **Both themes.** Only existing colours, type and card styles are used.

## Approaches

### A. Balance in the title row

The balance becomes one line at the right of the "Home" title: a small
"Balance" label, the sentence in 16px semibold, and a "How it adds up" button
that opens the side panel the page already has (`side-panel.tsx`, used for
"Getting started"). The Ledger moves up to where the balance card was. When To
do and To sort both have something, they sit side by side above the Ledger.

- **For:** gives back the most height, about 225px; the Ledger keeps its full
  width, so the table fits the 1000px window in the screenshot; works from
  640px up; smallest change.
- **Against:** it is the least grid-like. On the usual day the page is a title
  row and a ledger. The title row gets busy on the days it also holds "Paid
  personally" and "Getting started". A group with several debts needs a rule
  for how many lines to show (question 5).
- **Cost:** `page.tsx`, `home-balance.tsx`, and the two balance steps in
  `e2e/household.spec.ts`. One client. About half a day.

### B. Ledger with a side rail

Two columns: the Ledger on the left, and on the right a 300px rail holding a
small Balance card, then To do, then To sort.

- **For:** a real grid; the balance is a small card off to one side; To do and
  To sort stop pushing the Ledger down the page.
- **Against:** on the usual day the rail holds only the small balance card and
  is empty below it for the length of the Ledger. It takes 320px from the
  table: in the 1000px window of the screenshot the table would have about
  650px for six columns, which is too tight, so B needs the page widened
  (question 3) and only applies from about 1200px. Below that it has to fall
  back to something, which means building A or D as well. The forms inside To
  do and To sort are laid out for a wide card and would need checking at 300px.
- **Cost:** `page.tsx`, `home-balance.tsx`, `ui.tsx` (page width),
  `ledger-view.tsx`, a look at `home-todo.tsx` and `home-bank.tsx` at rail
  width, and the e2e story. One client. About a day and a half, more if every
  page is widened.

### C. A row of tiles

A row of small tiles above the Ledger: Balance, Last 30 days, To do, To sort.
Each is about 90px tall. The balance tile opens the same side panel as A. The
"Last 30 days" count moves out of the Ledger into its tile.

- **For:** reads as a dashboard; the balance is one detail among four; still
  fits a 1000px window; the row is always full, so no empty column.
- **Against:** saves less height than A (about 110px). To do and To sort hold
  forms, so a tile can only be a count that leads somewhere: either the full
  cards still appear below the tiles when they have items, which gives the
  space back, or they move into side panels, which hides work that today is in
  plain sight. "Last 30 days" changes meaning when a filter is on, so that tile
  needs a rule too (question 6).
- **Cost:** `page.tsx`, `home-balance.tsx`, `ledger-view.tsx`,
  `home-todo.tsx`, `home-bank.tsx`, the e2e story. One client. About a day and
  a half.

### D. Shrink the card where it is (not advised)

Keep the stack. The balance card becomes one 56px row: label, sentence in 16px,
and the fold at the right.

- **For:** an hour's work, one file, nothing else moves.
- **Against:** saves about 135px but leaves a full-width bar holding one
  sentence, and it is still a stack. It answers "too big" and ignores "grid".
- **Cost:** `home-balance.tsx`. About an hour.

## Recommendation

**A.** The complaint is mostly about height, the screenshot's window is 1000px
wide, and on the usual day there are only two things on the page, so a second
column has nothing to hold.

What would change it: if you normally keep the window wider than about 1280px,
or To do and To sort usually have items, B uses that width better and is worth
the extra day.

## Questions

1. **Which approach?** Recommend **A**.
2. **From what window width does the desktop layout apply?** Recommend
   **640px**, the width at which the Ledger already switches from cards to a
   table, so there is one breakpoint, not two. (B would need about 1200px
   whatever is chosen here.)
3. **Widen the page beyond 1024px?** Only matters for B. Recommend **no** for
   A, C and D. For B, recommend widening every page's header, nav and content
   to 1152px together, so the header does not shift between pages. That adds a
   look at every page to the ticket.
4. **Where does "How the balance adds up" open?** Recommend **the side panel**,
   as "Getting started" does. The alternative is a fold that opens in place
   under the title row and pushes the Ledger down.
5. **A group with more than one debt line.** Recommend showing **up to two
   lines**, then "and N more" opening the same panel.
6. **Only for C: what do the To do and To sort tiles do?** Recommend a count
   that scrolls to the full card, which still appears below the tiles when it
   has items.

## Not verified

- Nothing was run. Heights are measured from the screenshot, not from the app.
- The boards are drawings in the app's colours and type. They are not captures
  from the running app.
- I read `page.tsx`, `home-balance.tsx`, `ui.tsx`, `globals.css`,
  `side-panel.tsx` and parts of `ledger-view.tsx`, `home-todo.tsx` and
  `home-bank.tsx`. I did not open To do or To sort with real items in them, so
  the claim that their forms are tight at 300px is a reading of the markup.
- I assumed a group can show more than one debt line because `balance.owes` is
  a list. I did not check how many lines a three-person group produces.
- I assumed "desktop" means the web app in a wide window. Nothing here is for
  the iOS app.
- The side panel renders outside the Balance region, so the Playwright steps
  that click "How the balance adds up" inside that region will need to change.
  I read those steps and did not run them.
