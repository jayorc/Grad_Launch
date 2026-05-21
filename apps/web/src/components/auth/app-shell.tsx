"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useAuth } from "../../providers/auth-provider";

export function AppShell({ children }: { children: ReactNode }) {
  const { student, isAuthenticated, logoutUser, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const navItems = [
    { href: "/", label: "Home" },
    { href: "/profile", label: "Setup" },
    { href: "/search", label: "Find Jobs" },
    { href: "/jobs", label: "Review Jobs" },
    { href: "/applications", label: "Saved Applications" }
  ];

  async function handleLogout() {
    await logoutUser();
    router.push("/login");
  }

  const isAuthPage = pathname === "/login";

  return (
    <div className="shell">
      <div className="container">
        {isAuthPage ? (
          <div className="auth-shell">
            <header className="topbar auth-topbar">
              <div className="brand">
                <p className="eyebrow">Career Copilot</p>
                <h1>GradLaunch</h1>
                <p>Search, match, launch autopilot, and track every application in one place.</p>
              </div>
              <div className="session-bar">
                <Link className="button button-secondary" href="/login">
                  Login
                </Link>
              </div>
            </header>
            {children}
          </div>
        ) : (
          <div className="app-layout">
            <aside className="sidebar">
              <div className="sidebar-brand">
                <p className="eyebrow">Career Copilot</p>
                <h1>GradLaunch</h1>
                <p className="muted">One clean workspace for search, drafts, autopilot, handoff, and submission tracking.</p>
              </div>
              <nav className="sidebar-nav">
                {navItems.map((item) => {
                  const isActive = pathname === item.href;

                  return (
                    <Link className={`nav-link ${isActive ? "nav-link-active" : ""}`} href={item.href} key={item.href}>
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
              <div className="sidebar-agent-card">
                <p className="eyebrow">Agent</p>
                <strong>Autonomous with safe handoff</strong>
                <p className="muted">The agent keeps going on its own, pauses for login or OTP when needed, then resumes from the same flow.</p>
              </div>
              <div className="sidebar-footer">
                {loading ? (
                  <span className="muted">Loading session...</span>
                ) : isAuthenticated ? (
                  <>
                    <div className="session-card session-card-vertical">
                      <strong>{student?.fullName}</strong>
                      <span className="muted">{student?.email}</span>
                    </div>
                    <button className="button button-secondary button-block" onClick={handleLogout} type="button">
                      Logout
                    </button>
                  </>
                ) : (
                  <Link className="button button-primary button-block" href="/login">
                    Login
                  </Link>
                )}
              </div>
            </aside>
            <main className="main-panel">
              <header className="mobile-topbar">
                <div className="brand brand-compact">
                  <p className="eyebrow">Career Copilot</p>
                  <h1>GradLaunch</h1>
                </div>
                <div className="session-bar">
                  {student ? <span className="session-chip">{student.fullName.split(" ")[0]}</span> : null}
                </div>
              </header>
              {children}
            </main>
          </div>
        )}
      </div>
    </div>
  );
}
