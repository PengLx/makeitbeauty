import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Search, Square, Type } from "lucide-react";
import type { KitComponent, KitState } from "@/hooks/useKit";
import type { MyComponentsState } from "@/hooks/useMyComponents";
import { getComponentVersionCached } from "@/hooks/useComponentDefs";
import {
  listCommunity,
  toApiError,
  type ApiError,
  type CommunityComponent,
} from "@/lib/api";
import type { ComponentDefinition } from "@/lib/component";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

interface Props {
  kit: KitState;
  /** My components (drafts filtered out below — only published insert). */
  my: MyComponentsState;
  onInsertComponent: (component: KitComponent) => void;
  /**
   * Insert a user component instance pinned to `ref` ("{owner}/{name}@{n}" —
   * the LATEST published version at insert time; §7.5: updating is opt-in per
   * design, never silent). `def` is that version's immutable definition.
   */
  onInsertUserInstance: (ref: string, def: ComponentDefinition) => void;
  onInsertText: () => void;
  onInsertRect: () => void;
}

/** Left column: quick-add primitives + official kit + my/community components. */
export function Palette({
  kit,
  my,
  onInsertComponent,
  onInsertUserInstance,
  onInsertText,
  onInsertRect,
}: Props) {
  const myPublished = (my.components ?? []).filter((c) => c.latestVersion > 0);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-card">
      <div className="px-4 pt-3 pb-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Insert
        </h2>
      </div>
      <div className="grid grid-cols-2 gap-2 px-3 pb-3">
        <Button variant="outline" size="sm" onClick={onInsertText}>
          <Type data-icon="inline-start" />
          Text
        </Button>
        <Button variant="outline" size="sm" onClick={onInsertRect}>
          <Square data-icon="inline-start" />
          Rectangle
        </Button>
      </div>

      <Separator />

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-4 pt-3 pb-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Kit
          </h2>
        </div>
        <div className="px-3 pb-3">
          {kit.loading ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">Loading kit…</p>
          ) : kit.error ? (
            <div className="space-y-2 rounded-lg border border-dashed p-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                Kit unavailable — is the API running on :7800?
              </p>
              <Button variant="secondary" size="xs" onClick={kit.reload}>
                <RefreshCw data-icon="inline-start" />
                Retry
              </Button>
            </div>
          ) : kit.components.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              The kit registry is empty.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {kit.components.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => onInsertComponent(c)}
                    title={c.description}
                    className="w-full rounded-lg border bg-background px-3 py-2 text-left transition-colors
                      hover:border-ring hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">{c.title}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {c.frame.w}×{c.frame.h}
                      </span>
                    </div>
                    {c.description && (
                      <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {c.description}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-4 pt-1 pb-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            My components
          </h2>
        </div>
        <div className="px-3 pb-3">
          {my.error ? (
            // Same silent degradation as binding surfaces: signed-out or API
            // down means no personal registry — the section stays quiet.
            <p className="px-1 py-1 text-[11px] text-muted-foreground">
              {my.error.status === 401
                ? "Sign in to use your published components."
                : "My components unavailable."}
            </p>
          ) : my.loading ? (
            <p className="px-1 py-1 text-xs text-muted-foreground">Loading…</p>
          ) : myPublished.length === 0 ? (
            <p className="px-1 py-1 text-[11px] leading-relaxed text-muted-foreground">
              Nothing published yet — build one in the Components studio.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {myPublished.map((c) => (
                <li key={c.id}>
                  <UserComponentCard
                    id={c.id}
                    title={c.title}
                    subtitle={c.id}
                    version={c.latestVersion}
                    onInsert={onInsertUserInstance}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        <CommunitySection onInsert={onInsertUserInstance} />
      </ScrollArea>

      <Separator />
      <p className="px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
        Click a card to insert it centered on the canvas.
      </p>
    </aside>
  );
}

/**
 * Community browse per §8: GET /v1/community/components?q= (published, newest
 * first). The input live-searches debounced; "" is the browse-everything
 * query, fired on mount too.
 */
function CommunitySection({
  onInsert,
}: {
  onInsert: (ref: string, def: ComponentDefinition) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CommunityComponent[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      async () => {
        setLoading(true);
        try {
          setResults(await listCommunity(q, controller.signal));
          setError(null);
        } catch (e) {
          if (controller.signal.aborted) return;
          setError(toApiError(e));
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      },
      // First browse fires immediately; typing debounces.
      results == null && q === "" ? 0 : 350,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, attempt]);

  return (
    <>
      <div className="px-4 pt-1 pb-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Community
        </h2>
      </div>
      <div className="space-y-2 px-3 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search components…"
            spellCheck={false}
            className="h-8 pl-7 text-xs"
            aria-label="Search community components"
          />
        </div>

        {error ? (
          <div className="space-y-2 rounded-lg border border-dashed p-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Community search unavailable.
            </p>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setAttempt((n) => n + 1)}
            >
              <RefreshCw data-icon="inline-start" />
              Retry
            </Button>
          </div>
        ) : results == null || loading ? (
          <p className="px-1 py-1 text-xs text-muted-foreground">Searching…</p>
        ) : results.length === 0 ? (
          <p className="px-1 py-1 text-[11px] leading-relaxed text-muted-foreground">
            {q.trim() === ""
              ? "No published community components yet."
              : `Nothing matches “${q.trim()}”.`}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {results
              .filter((c) => c.latestVersion > 0)
              .map((c) => (
                <li key={c.id}>
                  <UserComponentCard
                    id={c.id}
                    title={c.title}
                    subtitle={`by ${c.owner}`}
                    version={c.latestVersion}
                    onInsert={onInsert}
                  />
                </li>
              ))}
          </ul>
        )}
      </div>
    </>
  );
}

/**
 * One insertable user-component card (my/community share it). Insertion pins
 * "{id}@{latestVersion}" and needs that version's definition for frame size
 * and prop defaults — fetched through the module-level version cache, so a
 * second insert of the same card is instant.
 */
function UserComponentCard({
  id,
  title,
  subtitle,
  version,
  onInsert,
}: {
  id: string;
  title: string;
  subtitle: string;
  version: number;
  onInsert: (ref: string, def: ComponentDefinition) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function insert() {
    if (busy) return;
    const ref = `${id}@${version}`;
    setBusy(true);
    setError(null);
    try {
      const def = await getComponentVersionCached(ref);
      onInsert(ref, def);
    } catch (e) {
      setError(toApiError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={() => void insert()}
      disabled={busy}
      className="w-full rounded-lg border bg-background px-3 py-2 text-left transition-colors
        hover:border-ring hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none
        disabled:opacity-60"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <span className="truncate">{title}</span>
          {busy && (
            <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
          )}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          v{version}
        </span>
      </div>
      <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
        {subtitle}
      </div>
      {error && <div className="mt-1 text-[10px] text-destructive">{error}</div>}
    </button>
  );
}
