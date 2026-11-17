"use client";

import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { THEME_COLOR, THEME_COOKIE, type Theme } from "@/lib/theme";

// Flips between light and dark. The icon is chosen by CSS (the `dark:`
// variant), so the server and the first render agree whatever the system
// setting is, and nothing here needs state.
export function ThemeSwitch() {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label="Switch between light and dark"
      title="Light or dark"
      onClick={() => {
        const root = document.documentElement;
        const now: Theme = root.dataset.theme === "dark" || (!root.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
        const next: Theme = now === "dark" ? "light" : "dark";
        root.dataset.theme = next;
        document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
        for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
          meta.setAttribute("content", THEME_COLOR[next]);
          meta.removeAttribute("media");
        }
      }}
    >
      <Sun className="dark:hidden" />
      <Moon className="hidden dark:block" />
    </Button>
  );
}
