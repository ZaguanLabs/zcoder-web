import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import { LoginForm } from "@/components/login-form";

const loginErrors: Record<string, string> = {
  origin: "Open zweb using its configured APP_ORIGIN.",
  locked: "Too many attempts. Wait before trying again.",
  config: "Login is not configured on this server.",
  request: "The login request was invalid.",
  credentials: "Username or password is incorrect.",
  expired: "Your session expired. Sign in again to continue.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await isAuthenticated()) redirect("/");
  const { error } = await searchParams;
  return <LoginForm initialError={error ? loginErrors[error] || "Login failed." : ""} />;
}
