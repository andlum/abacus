import { redirect } from "next/navigation";

// This used to be its own page. The to-do list now lives on Home.
export default function Moved() {
  redirect("/#to-do");
}
