// A stand-in for the real sign-in, for browser tests and for trying the app on your
// own machine. It lets anyone pick a member without a password, so it works
// only outside production builds, and only when asked for.
export const DEV_AUTH_COOKIE = "abacus_dev_member";
export const DEV_TODAY_COOKIE = "abacus_dev_today";

export function devAuthEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ABACUS_E2E === "1" && env.NODE_ENV !== "production";
}
