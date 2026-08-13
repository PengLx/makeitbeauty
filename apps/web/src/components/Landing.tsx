import type { ApiError } from "@/lib/api";
import { ExamplesStrip } from "./landing/ExamplesStrip";
import { FeatureGrid } from "./landing/FeatureGrid";
import { Hero } from "./landing/Hero";
import { HowItWorks } from "./landing/HowItWorks";
import { LandingFooter } from "./landing/LandingFooter";
import { LandingNav } from "./landing/LandingNav";

interface Props {
  /** Non-401 boot failure (API unreachable etc.); 401 renders no error. */
  error: ApiError | null;
  onRetry: () => void;
}

/**
 * Signed-out home (App renders this only for the logged-out boot phase; the
 * signed-in redirect flow is untouched). The marketing page for
 * makeitbeauty.org: every card shown is real renderer output committed as a
 * source asset — see src/components/landing/showcase.ts. The sign-in control
 * stays a plain anchor — /v1/auth/github/login must be a full navigation
 * (302 to GitHub) through the /v1 proxy, not a fetch.
 */
export function Landing({ error, onRetry }: Props) {
  return (
    <div className="min-h-screen bg-[#0d1117] text-slate-200 antialiased">
      {/* Page-side float keyframes for the hero collage. Usage is gated
          behind motion-safe:, so reduced-motion users get a static collage;
          the keyframes themselves are inert without those classes. */}
      <style>{`
        @keyframes mib-float-a { 0%, 100% { transform: translateY(0) } 50% { transform: translateY(-10px) } }
        @keyframes mib-float-b { 0%, 100% { transform: translateY(0) } 50% { transform: translateY(8px) } }
      `}</style>
      <LandingNav />
      <main>
        <Hero error={error} onRetry={onRetry} />
        <ExamplesStrip />
        <HowItWorks />
        <FeatureGrid />
      </main>
      <LandingFooter />
    </div>
  );
}
