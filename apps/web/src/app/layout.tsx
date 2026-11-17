import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Toaster } from "./toast";
import { Figtree, Fraunces } from "next/font/google";
import { cookies } from "next/headers";
import { parseTheme, THEME_COLOR, THEME_COOKIE } from "@/lib/theme";
import { cn } from "@/lib/utils";

const figtree = Figtree({ subsets: ["latin"], variable: "--font-figtree" });
// Page titles, the wordmark and the big numbers. SOFT rounds the corners.
const fraunces = Fraunces({ subsets: ["latin"], axes: ["SOFT", "opsz"], variable: "--font-fraunces" });

export const metadata: Metadata = {
  title: "Clementine",
  robots: { index: false, follow: false },
  icons: { icon: "/icons/192.png", apple: "/icons/apple-touch.png" },
  // Full screen when opened from an iPhone's home screen, too.
  appleWebApp: { capable: true, title: "Clementine", statusBarStyle: "default" },
};

async function savedTheme() {
  return parseTheme((await cookies()).get(THEME_COOKIE)?.value);
}

// The browser's own chrome takes the page's ground colour: the mode someone
// picked with the switch, or else the system's, day and night.
export async function generateViewport(): Promise<Viewport> {
  const theme = await savedTheme();
  if (theme) return { themeColor: THEME_COLOR[theme] };
  return {
    themeColor: [
      { media: "(prefers-color-scheme: light)", color: THEME_COLOR.light },
      { media: "(prefers-color-scheme: dark)", color: THEME_COLOR.dark },
    ],
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = await savedTheme();
  return (
    <html lang="en" data-theme={theme} className={cn("font-sans", figtree.variable, fraunces.variable)}>
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
