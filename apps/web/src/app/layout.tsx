import "./globals.css";
import type { ReactNode } from "react";
import { AgentCompanionWidget } from "../components/agent-companion-widget";
import { AppShell } from "../components/auth/app-shell";
import { AgentConsoleProvider } from "../providers/agent-console-provider";
import { AuthProvider } from "../providers/auth-provider";

export const metadata = {
  title: "GradLaunch",
  description: "AI-assisted job application copilot for students."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <AgentConsoleProvider>
            <AppShell>{children}</AppShell>
            <AgentCompanionWidget />
          </AgentConsoleProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
