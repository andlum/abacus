import { UserError } from "@abacus/core/errors";
import { CARD_MODES } from "@/db/schema";
import { idParam, jsonBody, route, str } from "@/lib/api";
import { cardAccount, setCardMode } from "@/lib/card-review";
import { ownCard } from "../_card/helpers";

export const dynamic = "force-dynamic";

const cardId = (id: string) => idParam(id, "card");

export const GET = route<{ id: string }>(async ({ db, me }, _req, { id }) => ownCard(cardAccount(db, me, cardId(id))));

// Whether the card's payments are shared. Only the card's owner may.
export const PATCH = route<{ id: string }>(async ({ db, me }, req, { id }) => {
  const b = await jsonBody(req);
  const mode = str(b, "cardMode");
  if (!(CARD_MODES as readonly string[]).includes(mode)) throw new UserError("cardMode must be shared or personal");
  await ownCard(setCardMode(db, me, cardId(id), mode as (typeof CARD_MODES)[number]));
  return cardAccount(db, me, cardId(id));
});
