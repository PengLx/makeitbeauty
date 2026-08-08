import { useState } from "react";
import type { ReactNode } from "react";
import { Check, Copy, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const DEV_DEPLOY_TOKEN = "dev-demo-token";

/**
 * Single-project trim of packages/action/templates/profile-workflow.yml,
 * prefilled for project "demo". Kept in sync by hand until real project
 * management generates this server-side (next phase).
 */
const WORKFLOW_YML = `# MakeItBeauty — profile refresh workflow (project: demo)
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

      - name: Render demo
        uses: makeitbeauty/action@v0
        with:
          project: demo
          deploy-token: \${{ secrets.MAKEITBEAUTY_DEPLOY_TOKEN }}
          output: default
          path: rendered/assets/card.svg

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

const README_SNIPPET = `<img src="https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_USERNAME/output/assets/card.svg"
     alt="Profile card" />`;

/** Header "Deploy" button + instructions dialog. Static v0 for project "demo". */
export function DeployDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm">
          <Rocket data-icon="inline-start" />
          Deploy
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Deploy “demo” to your profile</DialogTitle>
          <DialogDescription>
            Your repo pulls a fresh render on a schedule and commits it to an{" "}
            <code className="font-mono text-xs">output</code> branch — MakeItBeauty
            never pushes to your repos. See docs/architecture.md §3.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-5 overflow-y-auto pr-1">
          <Step n={1} title="Add the workflow to your profile repo">
            <p className="text-xs text-muted-foreground">
              Save as{" "}
              <code className="font-mono">.github/workflows/makeitbeauty.yml</code>{" "}
              in the repo named after your username.
            </p>
            <Snippet text={WORKFLOW_YML} label="workflow" tall />
          </Step>

          <Step n={2} title="Add the deploy token as a repo secret">
            <p className="text-xs text-muted-foreground">
              Settings → Secrets and variables → Actions → New repository secret,
              named <code className="font-mono">MAKEITBEAUTY_DEPLOY_TOKEN</code>.
              This is the dev token — per-project tokens with revocation arrive
              with project management.
            </p>
            <Snippet text={DEV_DEPLOY_TOKEN} label="token" />
          </Step>

          <Step n={3} title="Embed the image in your README">
            <p className="text-xs text-muted-foreground">
              References the output branch through raw.githubusercontent.com;
              GitHub's Camo proxy caches it for ~5 minutes, so refreshes appear
              shortly after each run.
            </p>
            <Snippet text={README_SNIPPET} label="embed" />
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
