import { RefreshCw } from "lucide-react";
import type { ApiError } from "@/lib/api";
import { GitHubMark } from "@/components/ConnectorIcon";
import { Button } from "@/components/ui/button";

interface Props {
  /** Non-401 boot failure (API unreachable etc.); 401 renders no error. */
  error: ApiError | null;
  onRetry: () => void;
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
