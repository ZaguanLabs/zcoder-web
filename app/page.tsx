import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import { ConsoleApp } from "@/components/console-app";

export default async function Home() {
  if (!await isAuthenticated()) redirect("/login");
  return <ConsoleApp />;
}

