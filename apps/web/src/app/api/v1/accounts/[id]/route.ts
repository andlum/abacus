import { UserError } from "@abacus/core/errors";
import { CARD_MODES } from "@/db/schema";
import { idParam, jsonBody, route, str } from "@/lib/api";
import { setAccountKind } from "@/lib/accounts";
import { cardAccount, setCardMode } from "@/lib/card-review";
import { ownCard } from "../_card/helpers";

export const dynamic = "force-dynamic";

const cardId = (id: string) => idParam(id, "card");

export const GET = route<{ id: string }>(async ({ db, me }, _req, { id }) => ownCard(cardAccount(db, me, cardId(id))));

// In a household, `cardMode`: whether the card's payments are shared. In a
// business group, `kind`: whose card it is, business or personal, fixed once
// anything is paid from it. Only the card's owner may.
export const PATCH = route<{ id: string }>(async ({ db, me, home }, req, { id }) => {
  const b = await jsonBody(req);
  if (b.kind !== undefined || home.kind === "business") {
    if (home.kind !== "business") throw new UserError("kind is set on a business group's card; a household's card takes cardMode");
    if (b.cardMode !== undefined) throw new UserError("a business group's card takes kind (business or personal), not cardMode");
    // Not the caller's card reads as not found, before anything is changed.
    await ownCard(cardAccount(db, me, cardId(id)));
    await setAccountKind(db, me, cardId(id), str(b, "kind"));
    return cardAccount(db, me, cardId(id));
  }
  const mode = str(b, "cardMode");
  if (!(CARD_MODES as readonly string[]).includes(mode)) throw new UserError("cardMode must be shared or personal");
  await ownCard(setCardMode(db, me, cardId(id), mode as (typeof CARD_MODES)[number]));
  return cardAccount(db, me, cardId(id));
});
