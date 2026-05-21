"use client";

import { ProtectedPage } from "./auth/protected-page";
import { SearchSessionPanel } from "./search-session-panel";
import { useAuth } from "../providers/auth-provider";
import { PageHeader } from "./page-header";

export function SearchPageClient() {
  const { session } = useAuth();

  return (
    <ProtectedPage>
      <PageHeader
        eyebrow="Find Jobs"
        title="Ask GradLaunch to search for matching jobs"
        description="This is the job discovery step. Choose how broad the search should be, run the search, and review the best recommendations."
      />
      {session ? <SearchSessionPanel token={session.token} /> : null}
    </ProtectedPage>
  );
}
