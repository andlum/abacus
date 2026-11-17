import { redirect } from "next/navigation";

// This used to be its own page. It is now part of a Settings page.
export default function Moved() {
  redirect("/settings/people#income");
}
