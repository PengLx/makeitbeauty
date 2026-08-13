import { RefreshCw } from "lucide-react";
import type { ApiError } from "@/lib/api";
import { GitHubMark } from "@/components/ConnectorIcon";
import { Button } from "@/components/ui/button";
import { REPO_URL, SIGN_IN_URL } from "./links";
import { heroCard, heroFloaters } from "./showcase";

interface Props {
  /** Non-401 boot failure (API unreachable etc.); 401 renders no error. */
  error: ApiError | null;
  onRetry: () => void;
}

/**
 * Above-the-fold hero: headline + CTAs on the left, a floating collage of
 * real renderer output on the right. The collage floats are page-side CSS
 * (keyframes in Landing.tsx), gated behind motion-safe; the animations
 * INSIDE the SVGs are the renderer's own output playing via <img>.
 */
export function Hero({ error, onRetry }: Props) {
  const [progressBar, terminalCard] = heroFloaters;
  return (
    <section
      aria-labelledby="hero-heading"
      className="mx-auto grid w-full max-w-6xl items-center gap-12 px-5 pb-20 pt-14 sm:px-8 lg:grid-cols-2 lg:gap-10 lg:pt-24"
    >
      <div className="flex max-w-xl flex-col items-start gap-6">
        <p className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium tracking-wide text-slate-300">
          Open source · MIT · self-hostable
        </p>
        <h1
          id="hero-heading"
          className="font-heading text-4xl font-semibold leading-[1.08] tracking-tight text-slate-50 sm:text-5xl"
        >
          Your GitHub profile,{" "}
          <span className="bg-gradient-to-r from-cyan-300 via-sky-400 to-fuchsia-400 bg-clip-text text-transparent">
            drawn from live data
          </span>
        </h1>
        <p className="text-base leading-relaxed text-slate-400 sm:text-lg">
          Design profile-README images on a visual canvas, bind them to your
          real GitHub stats, and deploy from your own repo — which stays in
          control of every pixel.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild size="lg" className="h-10 px-4 text-sm">
            <a href={SIGN_IN_URL}>
              <GitHubMark data-icon="inline-start" />
              Sign in with GitHub
            </a>
          </Button>
          <Button asChild variant="outline" size="lg" className="h-10 px-4 text-sm">
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              View on GitHub
            </a>
          </Button>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>
              Couldn't check your session{" "}
              <code className="font-mono text-[10px] opacity-70">
                [{error.code}]
              </code>
            </span>
            <Button variant="ghost" size="xs" onClick={onRetry}>
              <RefreshCw data-icon="inline-start" />
              Retry
            </Button>
          </div>
        )}
      </div>

      <figure className="mx-auto w-full max-w-xl lg:max-w-none">
        {/* Floaters anchor to this wrapper (the main card's box), NOT the
            figure — the figure also contains the caption, and anchoring to
            it would drop the terminal card on top of the caption text. */}
        <div className="relative">
          <img
            src={heroCard.src}
            alt={heroCard.alt}
            width={heroCard.width}
            height={heroCard.height}
            fetchPriority="high"
            className="h-auto w-full rounded-2xl shadow-2xl shadow-black/60 ring-1 ring-white/10"
          />
          <img
            src={progressBar.src}
            alt={progressBar.alt}
            width={progressBar.width}
            height={progressBar.height}
            className="absolute -right-3 -top-9 hidden w-[52%] drop-shadow-2xl motion-safe:animate-[mib-float-a_9s_ease-in-out_infinite] sm:block lg:-right-8"
          />
          <img
            src={terminalCard.src}
            alt={terminalCard.alt}
            width={terminalCard.width}
            height={terminalCard.height}
            className="absolute -bottom-12 -left-3 hidden w-[58%] drop-shadow-2xl motion-safe:animate-[mib-float-b_11s_ease-in-out_infinite] sm:block lg:-left-8"
          />
        </div>
        <figcaption className="mt-6 text-center text-xs text-slate-500 sm:mt-20">
          Every card on this page is real MakeItBeauty output — same renderer,
          same pipeline as your README.
        </figcaption>
      </figure>
    </section>
  );
}
