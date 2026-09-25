import { redirect } from "next/navigation";

/** 9.14 (boss): the public buyback / burn dashboard is retired — the 5% goes to the project's buyback multisig and
 *  burns are done by hand (recorded in /admin only). Old links land on the home page. */
export default function BurnPage() {
  redirect("/");
}
