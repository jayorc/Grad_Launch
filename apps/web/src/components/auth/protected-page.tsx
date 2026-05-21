"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "../../providers/auth-provider";

export function ProtectedPage({ children }: { children: ReactNode }) {
  const { isAuthenticated, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated, loading, router]);

  if (loading) {
    return <div className="card section-card">Restoring your GradLaunch session...</div>;
  }

  if (!isAuthenticated) {
    return <div className="card section-card">Redirecting to login...</div>;
  }

  return <>{children}</>;
}

