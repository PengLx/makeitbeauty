import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Check, Copy, KeyRound, RefreshCw, Rocket } from "lucide-react";
import {
  ApiError,
  createDeployToken,
  listDeployTokens,
  revokeDeployToken,
  toApiError,
  type CreatedDeployToken,
  type DeployTokenInfo,
  type Output,
  type Project,
} from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** Single-domain architecture: nginx serves the SPA and proxies /v1 to the API,
 * so the Action's api-url is always the origin the editor itself runs on.
 * Auto-detected, not user-editable — in dev the Vite proxy makes the origin
 * work too. */
const API_URL = window.location.origin;

/** The Action step needs an output to name a file; API-created projects always
 * have one, but guard anyway so the dialog never renders broken snippets. */
function firstOutput(project: Project): Output {
  return project.outputs.length > 0
    ? project.outputs[0]
    : { id: "default", filename: "card.svg" };
}

/**
 * Single-project trim of packages/action/templates/profile-workflow.yml,
 * interpolated with the real project id, output and API URL.
 */
function workflowYml(project: Project, output: Output, apiUrl: string): string {
  return `# MakeItBeauty — profile refresh workflow (project: ${project.id})
#
# KEEPALIVE NOTE: GitHub disables scheduled workflows after ~60 days without
# repo activity; any commit or re-enabling the workflow resets the clock.

name: Refresh MakeItBeauty images

on:
  schedule:
    # Off-the-hour on purpose: on-the-hour crons queue behind everyone else's.
    - cron: "17 3 * * *"
  workflow_dispatch: {}

permissions:
  contents: write

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Render ${project.id}
        uses: PengLx/makeitbeauty/packages/action@main
        with:
          api-url: ${apiUrl}
          project: ${project.id}
          deploy-token: \${{ secrets.MAKEITBEAUTY_DEPLOY_TOKEN }}
          output: ${output.id}
          path: rendered/assets/${output.filename}

      - name: Commit to output branch
        # The output branch is kept at a SINGLE forced commit: no history
        # accumulates, and bot commits never touch your default branch or
        # contribution graph. Renders are deterministic, so the push is
        # skipped entirely when nothing changed.
        run: |
          set -euo pipefail
          git fetch --depth=1 origin output || true
          git checkout --orphan output
          git rm -rf --quiet .
          cp -r rendered/. .
          rm -rf rendered
          git add -A
          if git diff --quiet "origin/output" -- 2>/dev/null; then
            echo "No changes — skipping commit."
            exit 0
          fi
          git -c user.name="makeitbeauty[bot]" \\
              -c user.email="bot@makeitbeauty.dev" \\
              commit -m "render: refresh images"
          git push --force origin output
`;
}

function embedSnippet(output: Output): string {
  return `<img src="https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_USERNAME/output/assets/${output.filename}"
     alt="Profile card" />`;
}

interface Props {
  project: Project;
}

/**
 * Header "Deploy" button + instructions dialog with real deploy-token
 * management (architecture §8): tokens are listed masked on open; generating
 * one shows the plaintext exactly once — closing the dialog forgets it.
 */
export function DeployDialog({ project }: Props) {
  const [open, setOpen] = useState(false);

  const [tokens, setTokens] = useState<DeployTokenInfo[] | null>(null);
  const [tokensError, setTokensError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [fresh, setFresh] = useState<CreatedDeployToken | null>(null);
  const [generating, setGenerating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [mutError, setMutError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setTokensError(null);
    (async () => {
      try {
        setTokens(await listDeployTokens(project.id, controller.signal));
      } catch (e) {
        if (controller.signal.aborted) return;
        setTokensError(toApiError(e));
      }
    })();
    return () => controller.abort();
  }, [open, project.id, attempt]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      // The plaintext token is shown exactly once; closing forgets it.
      setFresh(null);
      setTokens(null);
      setTokensError(null);
      setMutError(null);
    }
  }

  async function generate() {
    if (generating) return;
    setGenerating(true);
    setMutError(null);
    try {
      const created = await createDeployToken(project.id);
      setFresh(created);
      setTokens((prev) => [
        { id: created.id, createdAt: created.createdAt },
        ...(prev ?? []),
      ]);
    } catch (e) {
      setMutError(toApiError(e));
    } finally {
      setGenerating(false);
    }
  }

  async function revoke(tokenId: string) {
    if (revokingId != null) return;
    setRevokingId(tokenId);
    setMutError(null);
    try {
      await revokeDeployToken(project.id, tokenId);
      const now = new Date().toISOString();
      setTokens(
        (prev) =>
          prev?.map((t) => (t.id === tokenId ? { ...t, revokedAt: now } : t)) ??
          prev,
      );
      // Revoking the token that was just generated makes its plaintext useless.
      setFresh((f) => (f?.id === tokenId ? null : f));
    } catch (e) {
      setMutError(toApiError(e));
    } finally {
      setRevokingId(null);
    }
  }

  const output = firstOutput(project);
  const activeCount = tokens?.filter((t) => !t.revokedAt).length ?? 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Rocket data-icon="inline-start" />
          Deploy
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Deploy “{project.name}” to your profile</DialogTitle>
          <DialogDescription>
            Your repo pulls a fresh render on a schedule and commits it to an{" "}
            <code className="font-mono text-xs">output</code> branch — MakeItBeauty
            never pushes to your repos. See docs/architecture.md §3.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-5 overflow-y-auto pr-1">
          <Step n={1} title="Create a deploy token">
            <p className="text-xs text-muted-foreground">
              Per-project, pull-only and revocable — it can render this project,
              nothing else. Add it to your profile repo under Settings → Secrets
              and variables → Actions as{" "}
              <code className="font-mono">MAKEITBEAUTY_DEPLOY_TOKEN</code>.
            </p>

            {tokensError ? (
              <Alert variant="destructive">
                <AlertTitle>
                  Couldn't load tokens{" "}
                  <code className="font-mono text-[10px] opacity-70">
                    [{tokensError.code}]
                  </code>
                </AlertTitle>
                <AlertDescription>
                  <p>{tokensError.message}</p>
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => setAttempt((n) => n + 1)}
                  >
                    <RefreshCw data-icon="inline-start" />
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            ) : tokens == null ? (
              <p className="text-xs text-muted-foreground">Loading tokens…</p>
            ) : (
              <>
                {fresh && (
                  <div className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                    <p className="text-xs font-medium text-amber-500">
                      Copy it now — you won't see this token again.
                    </p>
                    <Snippet text={fresh.token} label="deploy token" />
                    <p className="text-[11px] text-muted-foreground">
                      Only a hash is stored server-side; closing this dialog
                      forgets the plaintext.
                    </p>
                  </div>
                )}

                {tokens.length > 0 && (
                  <ul className="space-y-1.5">
                    {tokens.map((t) => (
                      <li
                        key={t.id}
                        className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${
                          t.revokedAt ? "opacity-60" : ""
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="font-mono text-xs" aria-hidden>
                              ••••••••
                            </span>
                            <span className="truncate font-mono text-[10px] text-muted-foreground">
                              {t.id}
                            </span>
                            {t.revokedAt && (
                              <span className="rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                                revoked
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            created {timeAgo(t.createdAt)}
                          </p>
                        </div>
                        {!t.revokedAt && (
                          <Button
                            variant="destructive"
                            size="xs"
                            onClick={() => void revoke(t.id)}
                            disabled={revokingId != null}
                          >
                            {revokingId === t.id ? "Revoking…" : "Revoke"}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {tokens.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No deploy tokens yet — generate one to let your repo pull
                    renders.
                  </p>
                )}
                {tokens.length > 0 && activeCount === 0 && !fresh && (
                  <p className="text-xs text-muted-foreground">
                    All tokens are revoked — generate a new one.
                  </p>
                )}

                <Button
                  variant={activeCount === 0 ? "default" : "outline"}
                  size="sm"
                  onClick={() => void generate()}
                  disabled={generating}
                >
                  <KeyRound data-icon="inline-start" />
                  {generating
                    ? "Generating…"
                    : activeCount === 0
                      ? "Generate deploy token"
                      : "Generate new token"}
                </Button>
              </>
            )}

            {mutError && (
              <Alert variant="destructive">
                <AlertTitle>
                  Token operation failed{" "}
                  <code className="font-mono text-[10px] opacity-70">
                    [{mutError.code}]
                  </code>
                </AlertTitle>
                <AlertDescription>{mutError.message}</AlertDescription>
              </Alert>
            )}
          </Step>

          <Step n={2} title="Add the workflow to your profile repo">
            <p className="text-xs text-muted-foreground">
              Save as{" "}
              <code className="font-mono">.github/workflows/makeitbeauty.yml</code>{" "}
              in the repo named after your username.
            </p>
            <Snippet
              text={workflowYml(project, output, API_URL)}
              label="workflow"
              tall
            />
          </Step>

          <Step n={3} title="Embed the image in your README">
            <p className="text-xs text-muted-foreground">
              References the output branch through raw.githubusercontent.com;
              GitHub's Camo proxy caches it for ~5 minutes, so refreshes appear
              shortly after each run.
            </p>
            <Snippet text={embedSnippet(output)} label="embed" />
          </Step>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary font-mono text-[11px] text-primary-foreground">
          {n}
        </span>
        {title}
      </h3>
      <div className="space-y-2 pl-7">{children}</div>
    </section>
  );
}

/** Monospace block with a copy-to-clipboard button. */
function Snippet({ text, label, tall }: { text: string; label: string; tall?: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (e.g. non-secure context); leave the text selectable */
    }
  }

  return (
    <div className="relative rounded-lg border bg-card">
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={copy}
        aria-label={`Copy ${label}`}
        className="absolute top-1.5 right-1.5 z-10 bg-card/80 backdrop-blur"
      >
        {copied ? <Check className="text-emerald-500" /> : <Copy />}
      </Button>
      <pre
        className={`overflow-auto p-3 font-mono text-[11px] leading-relaxed text-foreground ${
          tall ? "max-h-56" : ""
        }`}
      >
        {text}
      </pre>
    </div>
  );
}
