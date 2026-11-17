import { headers } from "next/headers";

// The address of this site, such as https://abacus.example.com, with no
// trailing slash. It goes into emails, so it comes from BETTER_AUTH_URL when
// that is set: the request's host headers are whatever the sender says they
// are, and a member could use them to mail someone a link to another site.
// The request is only the fallback for a server run without that setting.
export async function siteAddress(): Promise<string> {
  const configured = process.env.BETTER_AUTH_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
}
