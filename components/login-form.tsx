"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import styles from "@/app/login/login.module.css";

const cls = (...parts: (string | boolean | undefined | null)[]) =>
  parts.filter(Boolean).join(" ");

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
    <main className={styles.page}>
      {/* Animated background */}
      <div className={styles.orbs} aria-hidden="true">
        <div className={cls(styles.orb, styles["orb--1"])} />
        <div className={cls(styles.orb, styles["orb--2"])} />
        <div className={cls(styles.orb, styles["orb--3"])} />
      </div>
      <div className={styles.gridOverlay} aria-hidden="true" />

      {/* Card */}
      <div className={styles.card}>
        {/* Logo */}
        <Link href="/" className={styles.logo}>
          <div className={styles.logoIcon}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
          </div>
          <div className={styles.logoText}>z<span>web</span></div>
        </Link>
        <p className={styles.tagline}>Remote zcoder access point</p>

        {/* Form */}
        <form className={styles.form} method="post" onSubmit={submit} aria-busy={pending}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="username">Operator</label>
            <div className={styles.inputWrap}>
              <input
                ref={usernameRef}
                className={styles.input}
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                disabled={pending}
                required
                aria-label="Operator"
                placeholder="username"
              />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="password">Passphrase</label>
            <div className={styles.passwordWrap}>
              <input
                className={styles.input}
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                disabled={pending}
                required
                aria-label="Passphrase"
                placeholder={pending ? "checking…" : "passphrase"}
              />
              <button
                type="button"
                className={styles.passwordToggle}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((v) => !v)}
                disabled={pending}
              >
                {showPassword ? "hide" : "show"}
              </button>
            </div>
          </div>

          {error ? <p className={styles.error} role="alert">{error}</p> : null}

          <button type="submit" className={styles.submit} disabled={pending}>
            <span>{pending ? "authenticating…" : "unlock"}</span>
            <span className={styles.submitArrow} aria-hidden="true">{pending ? "…" : "→"}</span>
          </button>
        </form>

        {/* Footer */}
        <Footer />
      </div>
    </main>
  );
}

function Footer() {
  const [host, setHost] = useState<string>("");
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setHost(new URL(window.location.origin).hostname);
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <footer className={styles.footer}>
      <span className={styles.footerDot} aria-hidden="true" />
      <span>credentials stay on</span>
      <span className={styles.footerHost}>{host || "this origin"}</span>
    </footer>
  );
}
