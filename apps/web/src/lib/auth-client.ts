import { createAuthClient } from "better-auth/react";

// The browser side of src/lib/auth.ts. Same origin, so no base URL.
export const authClient = createAuthClient();
