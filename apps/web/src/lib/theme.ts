// Light or dark, as someone chose with the switch in the header. With no
// choice saved the page follows the system setting.
export const THEME_COOKIE = "abacus_theme";
export type Theme = "light" | "dark";

// The page's ground colour in each mode, for the browser's own chrome.
export const THEME_COLOR: Record<Theme, string> = { light: "#FFF4E2", dark: "#13261F" };

export function parseTheme(value: string | undefined): Theme | undefined {
  return value === "light" || value === "dark" ? value : undefined;
}
