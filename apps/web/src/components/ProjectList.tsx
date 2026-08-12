import { useEffect, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { ImagePlus, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  ApiError,
  createProject,
  deleteProject,
  listProjects,
  toApiError,
  type Me,
  type Project,
} from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
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
import { ConfirmDialog } from "./ConfirmDialog";
import { SectionNav, type Section } from "./SectionNav";
import { SessionControls } from "./SessionControls";

interface Props {
  me: Me;
  onNavigate: (section: Section) => void;
  onOpen: (projectId: string) => void;
}

/**
 * Home view: card grid over GET /v1/projects with create (dialog → POST) and
 * delete (confirm → DELETE). Clicking a card opens it in the editor.
 */
export function ProjectList({ me, onNavigate, onOpen }: Props) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<ApiError | null>(null);

  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<ApiError | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setListError(null);
    (async () => {
      try {
        setProjects(await listProjects(controller.signal));
      } catch (e) {
        if (controller.signal.aborted) return;
        setListError(toApiError(e));
      }
    })();
    return () => controller.abort();
  }, [attempt]);

  function openCreate() {
    setName("");
    setCreateError(null);
    setCreateOpen(true);
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "" || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      // No design in the request: the API supplies the default design for
      // projects created without one — the client doesn't special-case it.
      const project = await createProject({ name: trimmed });
      onOpen(project.id);
    } catch (err) {
      setCreateError(toApiError(err));
      setCreating(false);
    }
  }

  async function handleDelete() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteProject(pendingDelete.id);
      setProjects((prev) => prev?.filter((p) => p.id !== pendingDelete.id) ?? prev);
      setPendingDelete(null);
    } catch (err) {
      setDeleteError(toApiError(err));
    } finally {
      setDeleting(false);
    }
  }

  function cardKeyDown(e: KeyboardEvent, projectId: string) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(projectId);
    }
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b bg-card px-4 py-2">
        <span className="text-sm font-semibold">MakeItBeauty</span>
        <SectionNav active="projects" onNavigate={onNavigate} />
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={openCreate}>
            <Plus data-icon="inline-start" />
            New project
          </Button>
          <Separator orientation="vertical" className="h-4!" />
          <SessionControls me={me} />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-6">
          {listError ? (
            <Alert variant="destructive" className="mx-auto max-w-md">
              <AlertTitle>
                Couldn't load projects{" "}
                <code className="font-mono text-[10px] opacity-70">
                  [{listError.code}]
                </code>
              </AlertTitle>
              <AlertDescription>
                <p>{listError.message} — is the API running on :7800?</p>
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
          ) : projects == null ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              Loading projects…
            </p>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center">
              <ImagePlus className="size-8 text-muted-foreground" />
              <div>
                <h2 className="text-base font-medium">Create your first image</h2>
                <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                  Design a profile-README card on a live canvas, bind it to real
                  data, and deploy it to your repo.
                </p>
              </div>
              <Button onClick={openCreate}>
                <Plus data-icon="inline-start" />
                New project
              </Button>
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((p) => (
                <li key={p.id}>
                  <Card
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpen(p.id)}
                    onKeyDown={(e) => cardKeyDown(e, p.id)}
                    className="h-full cursor-pointer gap-3 transition-colors hover:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <CardHeader>
                      <CardTitle className="truncate">{p.name}</CardTitle>
                      <CardDescription className="truncate font-mono text-xs">
                        {p.id}
                      </CardDescription>
                      <CardAction>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${p.name}`}
                          className="text-muted-foreground hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteError(null);
                            setPendingDelete(p);
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </CardAction>
                    </CardHeader>
                    <CardFooter className="text-[11px] text-muted-foreground">
                      Updated {timeAgo(p.updatedAt)}
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
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              Opens in the editor on a blank canvas — add text, shapes and kit
              components from the palette.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-project-name">Name</Label>
              <Input
                id="new-project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My profile card"
                autoFocus
              />
            </div>

            {createError && (
              <Alert variant="destructive">
                <AlertTitle>
                  Couldn't create project{" "}
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
              <Button type="submit" disabled={name.trim() === "" || creating}>
                {creating ? "Creating…" : "Create project"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pendingDelete != null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
        title={`Delete “${pendingDelete?.name ?? ""}”?`}
        description="This permanently deletes the project and invalidates its deploy tokens. Repos pulling this image keep their last committed render."
        confirmLabel={deleting ? "Deleting…" : "Delete project"}
        destructive
        busy={deleting}
        error={deleteError}
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}
