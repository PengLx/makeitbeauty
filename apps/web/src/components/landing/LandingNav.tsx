import { Star } from "lucide-react";
import { GitHubMark } from "@/components/ConnectorIcon";
import { Button } from "@/components/ui/button";
import { REPO_URL, SIGN_IN_URL } from "./links";

/** Sticky top strip: wordmark, repo link, sign-in. */
export function LandingNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-[#0d1117]/85 backdrop-blur">
      <nav
        aria-label="Main"
        className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-5 sm:px-8"
      >
        <a
          href="/"
          className="flex items-center gap-2 font-heading text-[15px] font-semibold tracking-tight text-slate-100"
        >
          {/* Wordmark glyph: a 2×2 heatmap corner — the product in four dots. */}
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="size-4 shrink-0"
          >
            <rect x="0" y="0" width="7" height="7" rx="1.8" fill="#39d353" />
            <rect x="9" y="0" width="7" height="7" rx="1.8" fill="#26a641" />
            <rect x="0" y="9" width="7" height="7" rx="1.8" fill="#006d32" />
            <rect x="9" y="9" width="7" height="7" rx="1.8" fill="#0e4429" />
          </svg>
          MakeItBeauty
        </a>

        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" className="text-slate-300">
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              <Star data-icon="inline-start" aria-hidden="true" />
              <span className="hidden sm:inline">Star on GitHub</span>
              <span className="sm:hidden">GitHub</span>
            </a>
          </Button>
          <Button asChild>
            <a href={SIGN_IN_URL}>
              <GitHubMark data-icon="inline-start" />
              Sign in
            </a>
          </Button>
        </div>
      </nav>
    </header>
  );
}
