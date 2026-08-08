import { RefreshCw } from "lucide-react";
import type { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";

interface Props {
  /** Non-401 boot failure (API unreachable etc.); 401 renders no error. */
  error: ApiError | null;
  onRetry: () => void;
}

/** GitHub mark — lucide dropped brand icons, so it's inlined (sized like one). */
function GitHubMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * Signed-out home: centered hero with the GitHub sign-in entry point. The
 * sign-in control is a plain anchor — /v1/auth/github/login must be a full
 * navigation (302 to GitHub) through the /v1 proxy, not a fetch.
 */
export function Landing({ error, onRetry }: Props) {
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <main className="flex flex-1 items-center justify-center p-6">
        <div className="flex max-w-md flex-col items-center gap-5 text-center">
          <h1 className="font-heading text-3xl font-semibold tracking-tight">
            MakeItBeauty
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Design profile-README images on a live canvas, bind them to real
            data, and deploy them straight to your repos.
          </p>
          <Button asChild size="lg">
            <a href="/v1/auth/github/login">
              <GitHubMark data-icon="inline-start" />
              Sign in with GitHub
            </a>
          </Button>

          {error && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
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
      </main>
    </div>
  );
}
