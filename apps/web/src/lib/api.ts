// The HTTP API under /api/v1, for the phone app and for self-hosters' scripts.
// Each route authenticates with `Authorization: Bearer <token>` (see
// api-tokens.ts), then calls the same functions the web pages and actions
// call. The shape of every response is described in openapi.ts.
import { eq } from "drizzle-orm";
import { UserError } from "@abacus/core/errors";
import { isMalformedInput, isUuid } from "./ids.ts";
import { isIsoDate, todayIn } from "@abacus/core/dates";
import { getDb } from "../db/client.ts";
import { household, member, type Expense, type Member, type Reimbursement, type Settlement } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { memberForToken } from "./api-tokens.ts";
import { devAuthEnabled } from "./dev-auth.ts";
import type { ExpenseWithShares } from "./expenses.ts";

// A failure with its HTTP status. A UserError becomes a 400.
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ApiContext = {
  me: Member;
  db: Db;
  home: typeof household.$inferSelect;
  members: Member[];
  today: string;
};

// With the sign-in stand-in on, this header sets the date, as the "Pretend
// today is" cookie does for the web app.
export const DEV_TODAY_HEADER = "x-abacus-today";

export async function apiContext(req: Request, db: Db = getDb()): Promise<ApiContext> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const me = token ? await memberForToken(db, token) : null;
  if (!me) throw new ApiError(401, "a valid API token is required");
  const [home] = await db.select().from(household).where(eq(household.id, me.householdId));
  const members = await db.select().from(member).where(eq(member.householdId, me.householdId)).orderBy(member.id);
  const pretend = devAuthEnabled() ? req.headers.get(DEV_TODAY_HEADER) : null;
  const today = pretend && isIsoDate(pretend) ? pretend : todayIn(home!.timezone, new Date());
  return { me, db, home: home!, members, today };
}

type Handler<P> = (ctx: ApiContext, req: Request, params: P) => Promise<Response | unknown>;

// Wraps a handler: authenticates, turns a returned value into JSON, and turns
// errors into `{ "error": "..." }` with a status.
export function route<P = Record<string, never>>(handler: Handler<P>) {
  return async (req: Request, context?: { params: Promise<P> }): Promise<Response> => {
    try {
      const ctx = await apiContext(req);
      const out = await handler(ctx, req, ((await context?.params) ?? {}) as P);
      return out instanceof Response ? out : Response.json(out);
    } catch (e) {
      if (e instanceof ApiError) return Response.json({ error: e.message }, { status: e.status });
      if (e instanceof UserError) return Response.json({ error: e.message }, { status: 400 });
      // An id in the body that is not one, which Postgres refused to read.
      if (isMalformedInput(e)) {
        console.warn(e);
        return Response.json({ error: "a value in the request is not valid" }, { status: 400 });
      }
      console.error(e);
      return Response.json({ error: "something went wrong" }, { status: 500 });
    }
  };
}

export const created = (body: unknown) => Response.json(body, { status: 201 });


// A path id that is not a UUID cannot name anything: answer 404, not a
// database error.
export function idParam(value: string | undefined, what: string): string {
  if (!value || !isUuid(value)) throw new ApiError(404, `there is no such ${what}`);
  return value;
}

// For lookups whose only failure is "not in this household".
export async function found<T>(lookup: Promise<T>, what: string): Promise<T> {
  try {
    return await lookup;
  } catch (e) {
    if (e instanceof UserError) throw new ApiError(404, `there is no such ${what}`);
    throw e;
  }
}

// ---- Request bodies ----------------------------------------------------------

export type Body = Record<string, unknown>;

export async function jsonBody(req: Request): Promise<Body> {
  let b: unknown;
  try {
    b = await req.json();
  } catch {
    throw new UserError("the request body must be JSON");
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new UserError("the request body must be a JSON object");
  return b as Body;
}

export function str(b: Body, key: string, optional?: false): string;
export function str(b: Body, key: string, optional: true): string | undefined;
export function str(b: Body, key: string, optional = false): string | undefined {
  const v = b[key];
  if (v === undefined || v === null) {
    if (optional) return undefined;
    throw new UserError(`${key} is required`);
  }
  if (typeof v !== "string") throw new UserError(`${key} must be a string`);
  return v.trim();
}

// Money and other counts arrive as whole numbers, never decimals.
export function cents(b: Body, key: string): number {
  const v = b[key];
  if (v === undefined || v === null) throw new UserError(`${key} is required`);
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new UserError(`${key} must be a whole number of cents`);
  return v;
}

export function date(b: Body, key: string, fallback?: string): string {
  const v = str(b, key, true) ?? fallback;
  if (!v || !isIsoDate(v)) throw new UserError(`${key} must be a date like 2026-01-31`);
  return v;
}

// A member of the caller's household, checked here so an id that is not a
// UUID is a 400 and not a database error.
export function memberId(b: Body, key: string, members: Member[], fallback?: string): string {
  const v = str(b, key, true) || fallback;
  if (!v) throw new UserError(`${key} is required`);
  if (!members.some((m) => m.id === v)) throw new UserError(`${key} must be a member of this household`);
  return v;
}

// ---- Response shapes ---------------------------------------------------------

export function memberJson(m: Member) {
  return { id: m.id, displayName: m.displayName };
}

export function expenseJson(e: ExpenseWithShares | (Expense & { shares?: Record<string, number> })) {
  return {
    id: e.id,
    date: e.date,
    description: e.description,
    category: e.category,
    accountId: e.accountId,
    totalCents: e.totalCents,
    payerId: e.payerId,
    status: e.status,
    source: e.source,
    ruleSource: e.ruleSource,
    unassignedReason: e.unassignedReason,
    templateLineageId: e.templateLineageId,
    period: e.period,
    supersedesId: e.supersedesId,
    shares: e.shares ?? {},
    createdAt: e.createdAt.toISOString(),
  };
}

export function reimbursementJson(r: Reimbursement) {
  return {
    id: r.id,
    memberId: r.memberId,
    amountCents: r.amountCents,
    date: r.date,
    accountId: r.accountId,
    note: r.note,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
  };
}

export function settlementJson(s: Settlement) {
  return {
    id: s.id,
    fromMemberId: s.fromMemberId,
    toMemberId: s.toMemberId,
    amountCents: s.amountCents,
    date: s.date,
    note: s.note,
    status: s.status,
    supersedesId: s.supersedesId,
    createdAt: s.createdAt.toISOString(),
    createdBy: s.createdBy,
  };
}
