import { UserError } from "@abacus/core/errors";

// Characters that change the direction of the text around them or cannot be
// seen: in a list, "Paper" + U+202E + "0004" can make the amount and payer
// after it read backwards. The joiners U+200C and U+200D are allowed, since
// Persian words and emoji sequences need them.
const HIDDEN = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c\u200b\u2060\ufeff\u2028\u2029]/u;

// The character rules for text a person will read in a list: a
// description, the reason given for a change, an account's name.
export function checkText(what: string, text: string, max: number) {
  if (/\p{Cc}/u.test(text)) throw new UserError(`the ${what} cannot contain control characters such as tabs or line breaks`);
  if (HIDDEN.test(text)) {
    throw new UserError(`the ${what} cannot contain invisible characters, such as ones that change the text direction`);
  }
  if (text.trim().length > max) throw new UserError(`that ${what} is too long; keep it under ${max} characters`);
}
