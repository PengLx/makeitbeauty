import { useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Blocks, Plus, RefreshCw } from "lucide-react";
import { toApiError, type ApiError, type Me } from "@/lib/api";
import { createComponent, updateComponent } from "@/lib/api";
import { COMPONENT_NAME_RE, splitComponentId } from "@/lib/component";
import {
  COMPONENT_TEMPLATES,
  seedDefinition,
  type ComponentTemplate,
} from "@/lib/componentTemplates";
import { twApproxStyle } from "@/lib/tw";
import { cn } from "@/lib/utils";
import { useMyComponents } from "@/hooks/useMyComponents";
import { timeAgo } from "@/lib/format";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { SectionNav, type Section } from "./SectionNav";
import { SessionControls } from "./SessionControls";
import { GitHubMark } from "./ConnectorIcon";

interface Props {
  me: Me;
  onNavigate: (section: Section) => void;
  /** Open one of my components in the Studio; id = "{owner}/{name}". */
  onOpen: (componentId: string) => void;
}

/** Draft/published pill, shared by list cards and the Studio header. */
export function VersionBadge({ latestVersion }: { latestVersion: number }) {
  if (latestVersion > 0) {
    return (
      <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-500">
        v{latestVersion}
      </span>
    );
  }
  return (
    <span className="rounded-full border border-dashed px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
      draft
    </span>
  );
}

/**
 * Components home: card grid over GET /v1/components (mine — drafts and
 * published) with create (dialog → POST). Clicking a card opens the Studio.
 */
export function ComponentList({ me, onNavigate, onOpen }: Props) {
  const { components, error, loading, reload } = useMyComponents();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [frameW, setFrameW] = useState(400);
  const [frameH, setFrameH] = useState(160);
  const [templateId, setTemplateId] =
    useState<ComponentTemplate["id"]>("blank");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<ApiError | null>(null);

  const template =
    COMPONENT_TEMPLATES.find((t) => t.id === templateId) ??
    COMPONENT_TEMPLATES[0];
  // Non-blank templates lay their nodes out for a specific frame, so the
  // frame inputs lock to it (still resizable later in the Studio).
  const frameLocked = template.seed != null;

  const nameValid = COMPONENT_NAME_RE.test(name);
  const frameValid =
    frameW > 0 && frameW <= 4096 && frameH > 0 && frameH <= 4096;
  const canCreate = nameValid && title.trim() !== "" && frameValid && !creating;

  function openCreate() {
    setName("");
    setTitle("");
    setFrameW(400);
    setFrameH(160);
    setTemplateId("blank");
    setCreateError(null);
    setCreateOpen(true);
  }

  /** Pick a starter: adopt its frame; prefill ONLY empty name/title fields. */
  function selectTemplate(t: ComponentTemplate) {
    setTemplateId(t.id);
    setFrameW(t.frame.w);
    setFrameH(t.frame.h);
    if (t.suggestedName && name === "") setName(t.suggestedName);
    if (t.seed && title === "") setTitle(t.label);
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!canCreate) return;
    setCreating(true);
    setCreateError(null);
    try {
      const record = await createComponent({
        name,
        title: title.trim(),
        frame: { w: frameW, h: frameH },
      });
      // Seed a non-blank starter into the fresh draft via the normal draft
      // PUT. Failure here is non-fatal by design: the component already
      // exists, so surfacing an error would strand the dialog on a name
      // that can no longer be re-created — open the (blank) draft instead.
      const seeded = seedDefinition(template, record.id, title.trim());
      if (seeded) {
        const target = splitComponentId(record.id);
        if (target) {
          try {
            await updateComponent(target.owner, target.name, seeded);
          } catch {
            /* open blank */
          }
        }
      }
      onOpen(record.id);
    } catch (err) {
      setCreateError(toApiError(err));
      setCreating(false);
    }
  }

  function cardKeyDown(e: KeyboardEvent, id: string) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(id);
    }
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b bg-card px-4 py-2">
        <span className="text-sm font-semibold">MakeItBeauty</span>
        <SectionNav active="components" onNavigate={onNavigate} />
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={openCreate}>
            <Plus data-icon="inline-start" />
            New component
          </Button>
          <Separator orientation="vertical" className="h-4!" />
          <SessionControls me={me} />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-6">
          {error ? (
            error.status === 401 ? (
              <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center">
                <Blocks className="size-8 text-muted-foreground" />
                <div>
                  <h2 className="text-base font-medium">Sign in to build components</h2>
                  <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                    Components are published under your GitHub login
                    (yourname/component) — a session names the namespace.
                  </p>
                </div>
                <Button asChild>
                  <a href="/v1/auth/github/login">
                    <GitHubMark data-icon="inline-start" />
                    Sign in with GitHub
                  </a>
                </Button>
              </div>
            ) : (
              <Alert variant="destructive" className="mx-auto max-w-md">
                <AlertTitle>
                  Couldn't load components{" "}
                  <code className="font-mono text-[10px] opacity-70">
                    [{error.code}]
                  </code>
                </AlertTitle>
                <AlertDescription>
                  <p>{error.message} — is the API running on :7800?</p>
                  <Button variant="secondary" size="xs" onClick={reload}>
                    <RefreshCw data-icon="inline-start" />
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            )
          ) : loading || components == null ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              Loading components…
            </p>
          ) : components.length === 0 ? (
            <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center">
              <Blocks className="size-8 text-muted-foreground" />
              <div>
                <h2 className="text-base font-medium">
                  Build your first component
                </h2>
                <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                  A component is a reusable design fragment with prop slots —
                  publish it and any design (yours or the community's) can pin
                  a version.
                </p>
              </div>
              <Button onClick={openCreate}>
                <Plus data-icon="inline-start" />
                New component
              </Button>
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {components.map((c) => (
                <li key={c.id}>
                  <Card
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpen(c.id)}
                    onKeyDown={(e) => cardKeyDown(e, c.id)}
                    className="h-full cursor-pointer gap-3 transition-colors hover:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 truncate">
                        <span className="truncate">{c.title}</span>
                        <VersionBadge latestVersion={c.latestVersion} />
                      </CardTitle>
                      <CardDescription className="truncate font-mono text-xs">
                        {c.id}
                      </CardDescription>
                    </CardHeader>
                    <CardFooter className="text-[11px] text-muted-foreground">
                      {c.updatedAt ? `Updated ${timeAgo(c.updatedAt)}` : " "}
                    </CardFooter>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setCreateError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New component</DialogTitle>
            <DialogDescription>
              Opens in the Studio as a private draft — declare props, lay out
              nodes inside the frame, then publish an immutable version.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label id="start-from-label">Start from</Label>
              {/* Radio cards: first-time creators open something beautiful
                  (tw gradients, prop slots, an animation) instead of an
                  empty frame. Swatches are painted by the same compiler
                  the renderer uses, so they preview honestly. */}
              <div
                role="radiogroup"
                aria-labelledby="start-from-label"
                className="grid grid-cols-2 gap-2"
              >
                {COMPONENT_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={templateId === t.id}
                    onClick={() => selectTemplate(t)}
                    className={cn(
                      "rounded-lg border p-2 text-left transition-colors hover:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                      templateId === t.id && "border-sky-500 ring-1 ring-sky-500",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "mb-1.5 block h-7 rounded-md",
                        t.swatchTw === "" && "border border-dashed",
                      )}
                      style={twApproxStyle(t.swatchTw)}
                    />
                    <span className="block text-xs font-medium">{t.label}</span>
                    <span className="block text-[11px] leading-snug text-muted-foreground">
                      {t.blurb}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-component-name">Name</Label>
              <Input
                id="new-component-name"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                placeholder="fancy-stat-card"
                spellCheck={false}
                className="font-mono"
                autoFocus
              />
              <p className="text-[11px] text-muted-foreground">
                Lowercase letters, digits and hyphens. Published as{" "}
                <code className="font-mono">
                  {me.user.login.toLowerCase()}/{nameValid ? name : "{name}"}
                </code>
                {name !== "" && !nameValid && (
                  <span className="text-destructive"> — invalid name</span>
                )}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-component-title">Title</Label>
              <Input
                id="new-component-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Fancy stat card"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="new-component-w">Frame width</Label>
                <Input
                  id="new-component-w"
                  type="number"
                  min={1}
                  max={4096}
                  value={frameW}
                  disabled={frameLocked}
                  onChange={(e) => setFrameW(Math.round(Number(e.target.value)))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-component-h">Frame height</Label>
                <Input
                  id="new-component-h"
                  type="number"
                  min={1}
                  max={4096}
                  value={frameH}
                  disabled={frameLocked}
                  onChange={(e) => setFrameH(Math.round(Number(e.target.value)))}
                />
              </div>
            </div>
            {frameLocked && (
              <p className="text-[11px] text-muted-foreground">
                Sized by the “{template.label}” starter — resize later by
                dragging the frame's edge in the Studio.
              </p>
            )}

            {createError && (
              <Alert variant="destructive">
                <AlertTitle>
                  Couldn't create component{" "}
                  <code className="font-mono text-[10px] opacity-70">
                    [{createError.code}]
                  </code>
                </AlertTitle>
                <AlertDescription>{createError.message}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={creating}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={!canCreate}>
                {creating ? "Creating…" : "Create component"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
