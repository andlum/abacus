import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth";

// Better Auth's own endpoints: sign-up, sign-in, sign-out, verification
// links and password reset. Public (see src/proxy.ts); each checks itself.
const handler = toNextJsHandler((request: Request) => getAuth().handler(request));
export const { GET, POST } = handler;
