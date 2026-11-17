import { redirect } from "next/navigation";

// This used to be its own page. The balance now lives on Home.
export default function Moved() {
  redirect("/#balance");
}
