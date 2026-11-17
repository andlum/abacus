// An error whose message is safe and useful to show to the person who
// caused it: a bad date, a missing field, an action that is not allowed.
export class UserError extends Error {
  override name = "UserError";
}
