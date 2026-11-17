// The parts of Settings, each on its own page, in the order the nav shows.
export const SECTIONS = [
  { slug: "people", label: "People", about: "Who is in the group, and how you share costs" },
  { slug: "categories", label: "Categories", about: "What costs are grouped under" },
  { slug: "accounts", label: "Connected accounts", about: "Cards and accounts that pay, and bank connections" },
  { slug: "transfer", label: "Export and import", about: "Expenses in and out as a CSV file" },
  { slug: "agents", label: "Agents", about: "Agents and the phone app that act for you" },
] as const;

export type SectionSlug = (typeof SECTIONS)[number]["slug"];

// Where an old one-page link (/settings#split) now lives.
export const OLD_ANCHORS: Record<string, string> = {
  people: "/settings/people",
  split: "/settings/people#split",
  income: "/settings/people#income",
  categories: "/settings/categories",
  accounts: "/settings/accounts",
  transfer: "/settings/transfer",
  devices: "/settings/agents#devices",
  agents: "/settings/agents",
};
