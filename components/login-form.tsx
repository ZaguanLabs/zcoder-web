"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";

export function LoginForm({ initialError = "" }: { initialError?: string }) {
  const router = useRouter();
  const [error, setError] = useState(initialError);
  const [pending, setPending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const finePointer = window.matchMedia("(min-width: 861px) and (pointer: fine)");
    if (!finePointer.matches) return;
    const frame = requestAnimationFrame(() => usernameRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Login failed");
      router.replace("/");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Login failed");
      setPending(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <header className="login-header">
          <div className="login-access-line"><span><i /> Access control</span><b>Locked</b></div>
          <div className="login-lockup">
            <div className="brand-mark" aria-hidden="true"><Icon name="bolt" size={22} /></div>
            <div>
              <p className="eyebrow">Remote zcoder</p>
              <h1 id="login-title">zweb<span className="cursor-mark">_</span></h1>
            </div>
          </div>
          <p className="login-copy">Sign in to reach your configured servers.</p>
        </header>

        <form method="post" action="/api/auth/login" onSubmit={submit} className="login-form">
          <div className="login-field">
            <label htmlFor="username">Operator</label>
            <input ref={usernameRef} id="username" name="username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={pending} required />
          </div>
          <div className="login-field">
            <label htmlFor="password">Passphrase</label>
            <div className="password-field">
              <input id="password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" disabled={pending} required />
              <button type="button" className="password-toggle" aria-pressed={showPassword} onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? "Hide" : "Show"}</button>
            </div>
          </div>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button type="submit" className="unlock-button" disabled={pending}>{pending ? "Verifying…" : "Unlock console"}<span aria-hidden="true">→</span></button>
        </form>

        <footer className="security-note"><span aria-hidden="true" /> POST only <b aria-hidden="true">·</b> upstream keys stay server-side</footer>
      </section>
    </main>
  );
}
