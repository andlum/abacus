import { ArrowLeftRight, Plus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { DEFAULT_CATEGORY, type Account, type Category, type Household, type Member } from "@/db/schema";
import { accountLabel, KIND_LABELS } from "@/lib/accounts";
import { devAuthEnabled } from "@/lib/dev-auth";
import { countsOn } from "@/lib/members";
import { requireGroups } from "@/lib/session";
import { SignOutButton } from "@/components/sign-out-button";
import { formatCents } from "@abacus/core/money";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GroupSwitcher } from "./group-switcher";
import { ClementineLogo } from "./logo";
import { MainNav } from "./main-nav";
import { ThemeSwitch } from "./theme-switch";

// `actions` sit on the right of the page title. Given the group's members,
// the nav offers to record a payment once two people are in it today.
export async function Shell(props: {
  home: Household;
  me: Member;
  members?: Member[];
  today: string;
  title: string;
  // A detail beside the title on a wide window, a full-width block under it
  // on a phone. Home puts the balance here.
  aside?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { groups, invitations } = await requireGroups();
  const canPay = (props.members ?? []).filter((m) => countsOn(m, props.today)).length > 1;
  return (
    <>
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 pt-5 pb-2 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Link href="/" aria-label="Clementine home" className="shrink-0">
            <ClementineLogo wordmark />
          </Link>
          <GroupSwitcher groups={groups} currentId={props.home.id} />
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground sm:gap-3">
          <span className="whitespace-nowrap">
            {props.me.displayName}
            <span className="hidden sm:inline"> · {props.today}</span>
          </span>
          {devAuthEnabled() ? (
            <LinkButton href="/dev-sign-in" variant="outline" size="sm">
              switch person
            </LinkButton>
          ) : (
            <SignOutButton />
          )}
          {/* On a phone the nav scrolls, so the add buttons live up here where they are always visible. */}
          {canPay && (
            <LinkButton href="/payments/new" variant="outline" size="icon" className="sm:hidden" aria-label="Record payment">
              <ArrowLeftRight />
            </LinkButton>
          )}
          <LinkButton href="/expenses/new" size="icon" className="sm:hidden" aria-label="Add expense">
            <Plus />
          </LinkButton>
          <ThemeSwitch />
        </div>
      </header>
      {invitations.length > 0 && (
        <p className="mx-auto max-w-5xl px-4 pb-1 text-sm text-muted-foreground sm:px-6">
          {invitations.length === 1 ? "You have an invitation to join a group." : `You have ${invitations.length} invitations to join a group.`}{" "}
          <Link href="/invitations" className="underline underline-offset-2">
            Review {invitations.length === 1 ? "it" : "them"}
          </Link>
        </p>
      )}
      {/* The nav stays at the top as the page scrolls, with the page showing faintly through it. */}
      <nav aria-label="Main" className="sticky top-0 z-10 border-b border-border/60 bg-background/75 backdrop-blur-xl backdrop-saturate-150">
        <div className="relative mx-auto flex max-w-5xl items-center gap-1 overflow-x-auto px-4 py-2 [scrollbar-width:none] sm:px-6">
          <MainNav />
          <LinkButton href="/expenses/new" className="ml-auto hidden sm:inline-flex">
            <Plus data-icon="inline-start" />
            Add expense
          </LinkButton>
          {canPay && (
            <LinkButton href="/payments/new" variant="outline" className="hidden sm:inline-flex">
              <ArrowLeftRight data-icon="inline-start" />
              Record payment
            </LinkButton>
          )}
        </div>
      </nav>
      <main className="mx-auto max-w-5xl px-4 pt-10 pb-24 sm:px-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <h1 className="mb-0">{props.title}</h1>
          {props.aside && <div className="max-sm:order-last max-sm:w-full sm:ml-auto sm:pb-1.5">{props.aside}</div>}
          {props.actions && <div className="flex items-center gap-2 pb-1">{props.actions}</div>}
        </div>
        {props.children}
      </main>
    </>
  );
}

// A link that looks like a button but stays a link for screen readers and tests.
export function LinkButton({
  href,
  variant,
  size,
  className,
  children,
  "aria-label": ariaLabel,
}: {
  href: string;
  variant?: "default" | "outline" | "secondary" | "ghost" | "link";
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
}) {
  return (
    <Link href={href} data-slot="button" aria-label={ariaLabel} className={cn(buttonVariants({ variant, size }), className)}>
      {children}
    </Link>
  );
}

// A section's fine print, folded under one line: the one-sentence note above
// it says what the section is for, and this says how it behaves.
export function FinePrint({ children }: { children: ReactNode }) {
  return (
    <details className="fine-print">
      <summary>How this works</summary>
      <p className="note">{children}</p>
    </details>
  );
}

export function Money({ cents }: { cents: number | null | undefined }) {
  return <>{cents === null || cents === undefined ? "—" : formatCents(cents)}</>;
}

// What a category is called; its slug if the group no longer has it.
export function categoryLabel(categories: Category[], slug: string) {
  return categories.find((c) => c.slug === slug)?.label ?? slug;
}

// The options of a category picker: the group's categories, leaving out the
// removed ones unless one is the current value.
export function CategoryOptions({ categories, value }: { categories: Category[]; value?: string }) {
  return (
    <>
      {categories
        .filter((c) => !c.removedAt || c.slug === value)
        .map((c) => (
          <option key={c.slug} value={c.slug}>
            {c.label}
            {c.removedAt ? " (removed)" : ""}
          </option>
        ))}
    </>
  );
}

export function CategorySelect({
  categories,
  value = DEFAULT_CATEGORY,
  name = "category",
}: {
  categories: Category[];
  value?: string;
  name?: string;
}) {
  return (
    <label>
      Category
      <select name={name} defaultValue={value}>
        <CategoryOptions categories={categories} value={value} />
      </select>
    </label>
  );
}

// `other` is what a cost has when nobody picked one, so it is not shown.
export function CategoryNote({ category, categories }: { category: string; categories: Category[] }) {
  return category === DEFAULT_CATEGORY ? null : <span className="note">({categoryLabel(categories, category)})</span>;
}

// "Joint card ··4242", and in a business group whose money it is:
// "Visa ··4242 · Personal".
export function accountText(a: Account): string {
  return accountLabel(a) + (a.kind ? ` · ${KIND_LABELS[a.kind]}` : "");
}

// A select box cuts its text at the right on a phone, so a long name is
// shortened here to keep the last four and the kind after it in view.
export const shortName = (name: string) => (name.length > 28 ? `${name.slice(0, 27).trimEnd()}…` : name);

// Which account a cost was paid from. Offers the group's accounts, leaving
// out archived ones unless one is the current value; shows nothing until the
// group has added an account under Settings, and then the form leaves the
// account as it is.
export function AccountSelect({ accounts, value, name = "accountId" }: { accounts: Account[]; value?: string | null; name?: string }) {
  const offered = accounts.filter((a) => !a.archivedAt || a.id === value);
  if (offered.length === 0) return null;
  return (
    // min-w-0: a long account name shortens in the box rather than widening
    // the form past a phone's screen.
    <label className="min-w-0">
      Paid from
      <select name={name} defaultValue={value ?? ""}>
        <option value="">Not recorded</option>
        {offered.map((a) => (
          <option key={a.id} value={a.id}>
            {accountText({ ...a, name: shortName(a.name) })}
            {a.archivedAt ? " (archived)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

export function PayerSelect({ members, value, name = "payerId" }: { members: Member[]; value?: string; name?: string }) {
  return (
    <label>
      Paid by
      <select name={name} defaultValue={value}>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}
