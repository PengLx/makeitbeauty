import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Heart,
  Loader2,
  RefreshCw,
  Search,
  Square,
  Type,
} from "lucide-react";
import type { KitComponent, KitState } from "@/hooks/useKit";
import type { MyComponentsState } from "@/hooks/useMyComponents";
import { getComponentVersionCached } from "@/hooks/useComponentDefs";
import {
  favoriteComponent,
  listCommunity,
  listFavoriteComponents,
  toApiError,
  unfavoriteComponent,
  type ApiError,
  type CommunityComponent,
} from "@/lib/api";
import { splitComponentId, type ComponentDefinition } from "@/lib/component";
import {
  applyFavorite,
  filterFavoriteRows,
  sortFavoriteRows,
} from "@/lib/favorites";
import {
  buildInstancePreviewDesign,
  materializeDefaultProps,
  pinnedPreviewKey,
} from "@/lib/hoverPreview";
import {
  DEFAULT_COMMUNITY_SORT,
  PALETTE_STORAGE_KEY,
  buildKitMenu,
  categoryLabel,
  isGroupOpen,
  matchesQuery,
  mergePalettePrefs,
  normalizeQuery,
  parsePalettePrefs,
  parsePaletteSort,
  type CommunitySort,
  type PaletteGroup,
} from "@/lib/paletteMenu";
import { cn } from "@/lib/utils";
import { CategoryChip } from "@/components/CategoryChip";
import { PreviewHoverCard } from "@/components/PreviewHoverCard";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

/** Collapsed-group state from "mib.palette"; unavailable storage = all open. */
function loadCollapsed(): Set<string> {
  try {
    return parsePalettePrefs(localStorage.getItem(PALETTE_STORAGE_KEY));
  } catch {
    return new Set();
  }
}

/** Community sort pref from "mib.palette"; unavailable storage = newest. */
function loadSort(): CommunitySort {
  try {
    return parsePaletteSort(localStorage.getItem(PALETTE_STORAGE_KEY));
  } catch {
    return DEFAULT_COMMUNITY_SORT;
  }
}

/** Merge one pref into "mib.palette" without clobbering the others. */
function storePrefs(patch: {
  collapsed?: ReadonlySet<string>;
  sort?: CommunitySort;
}) {
  try {
    localStorage.setItem(
      PALETTE_STORAGE_KEY,
      mergePalettePrefs(localStorage.getItem(PALETTE_STORAGE_KEY), patch),
    );
  } catch {
    /* private mode / quota — the in-memory state still applies */
  }
}

/**
 * Left column: the component MENU. Sticky on top: text/rect quick-add plus
 * ONE search box that filters every source below simultaneously — the kit
 * and my components client-side, community via the server's debounced `q`
 * search (lib/paletteMenu.ts keeps the matching rules aligned). Below, the
 * kit is grouped into collapsible category sections (state persisted per
 * category; searching force-expands and hides empty groups), then my
 * published components, then community browse with a click-to-filter
 * category facet.
 */
export function Palette({
  kit,
  my,
  onInsertComponent,
  onInsertUserInstance,
  onInsertText,
  onInsertRect,
}: Props) {
  const [query, setQuery] = useState("");
  const normalized = normalizeQuery(query);
  const searching = normalized !== "";

  // Persisted per-category open/closed state (groups default open).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(loadCollapsed);
  function toggleGroup(category: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      storePrefs({ collapsed: next });
      return next;
    });
  }

  // Persisted community sort (§8 browse orderings), applied server-side on
  // browse and client-side on the Favorites view.
  const [sort, setSort] = useState<CommunitySort>(loadSort);
  function changeSort(next: CommunitySort) {
    setSort(next);
    storePrefs({ sort: next });
  }

  // The palette's session signal: "My components" 401 means signed out —
  // favorites (hearts, the Favorites filter) need a session too. The dev
  // implicit user has a session, so it counts as signed in.
  const signedIn = my.error?.status !== 401;

  const kitGroups = buildKitMenu(kit.components, normalized);
  const myPublished = (my.components ?? []).filter((c) => c.latestVersion > 0);
  const myFiltered = myPublished.filter((c) => matchesQuery(c, normalized));

  return (
    <aside className="flex w-80 shrink-0 flex-col border-r bg-card">
      {/* Sticky top: quick-add primitives + the one search box. */}
      <div className="px-4 pt-3 pb-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Insert
        </h2>
      </div>
      <div className="grid grid-cols-2 gap-2 px-3 pb-2">
        <Button variant="outline" size="sm" onClick={onInsertText}>
          <Type data-icon="inline-start" />
          Text
        </Button>
        <Button variant="outline" size="sm" onClick={onInsertRect}>
          <Square data-icon="inline-start" />
          Rectangle
        </Button>
      </div>
      <div className="flex items-center gap-2 px-3 pb-3">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search components…"
            spellCheck={false}
            className="h-8 pl-7 text-xs"
            aria-label="Search kit, my, and community components"
          />
        </div>
        {/* Community ordering, persisted in "mib.palette". Sits beside the
            search box because the two compose: q narrows, sort ranks. */}
        <Select
          value={sort}
          onValueChange={(v) => changeSort(v as CommunitySort)}
        >
          <SelectTrigger
            className="shrink-0 text-xs"
            aria-label="Sort community components"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            <SelectItem value="newest" className="text-xs">
              Newest
            </SelectItem>
            <SelectItem value="uses" className="text-xs">
              Most used
            </SelectItem>
            <SelectItem value="favorites" className="text-xs">
              Most favorited
            </SelectItem>
          </SelectContent>
        </Select>
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
          ) : kitGroups.length === 0 ? (
            // Searching and every category group came up empty.
            <p className="px-1 py-1 text-[11px] leading-relaxed text-muted-foreground">
              Nothing in the kit matches “{query.trim()}”.
            </p>
          ) : (
            <div className="space-y-0.5">
              {kitGroups.map((group) => (
                <KitCategoryGroup
                  key={group.category}
                  group={group}
                  open={isGroupOpen(group.category, collapsed, searching)}
                  searching={searching}
                  onToggle={toggleGroup}
                  onInsertComponent={onInsertComponent}
                />
              ))}
            </div>
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
          ) : myFiltered.length === 0 ? (
            <p className="px-1 py-1 text-[11px] leading-relaxed text-muted-foreground">
              None of yours match “{query.trim()}”.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {myFiltered.map((c) => (
                <li key={c.id}>
                  <UserComponentCard
                    id={c.id}
                    title={c.title}
                    subtitle={c.id}
                    version={c.latestVersion}
                    category={c.category}
                    onInsert={onInsertUserInstance}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        <CommunitySection
          query={query}
          sort={sort}
          signedIn={signedIn}
          onInsert={onInsertUserInstance}
        />
      </ScrollArea>

      <Separator />
      <p className="px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
        Click a card to insert it centered on the canvas.
      </p>
    </aside>
  );
}

/**
 * One collapsible kit category group. Open/closed is the caller's persisted
 * state EXCEPT while searching: matches must never hide behind a collapsed
 * header, so search forces groups open (and toggling is suspended — the
 * persisted preference shouldn't churn from clicks that can't take effect).
 */
function KitCategoryGroup({
  group,
  open,
  searching,
  onToggle,
  onInsertComponent,
}: {
  group: PaletteGroup<KitComponent>;
  open: boolean;
  searching: boolean;
  onToggle: (category: string) => void;
  onInsertComponent: (component: KitComponent) => void;
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={() => {
        if (!searching) onToggle(group.category);
      }}
    >
      <CollapsibleTrigger
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-1.5 text-left transition-colors
          hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="text-xs font-medium">{categoryLabel(group.category)}</span>
        <span className="ml-auto rounded-full bg-muted px-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
          {group.items.length}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="space-y-1.5 pt-0.5 pb-2">
          {group.items.map((c) => (
            <li key={c.id}>
              {/* Kit registry ids ("kit/…") are the preview cache keys
                  verbatim. The native title tooltip is dropped — the
                  hover card carries the rendered preview instead. */}
              <PreviewHoverCard
                title={c.title}
                frame={c.frame}
                previewKey={c.id}
                getDesign={() =>
                  buildInstancePreviewDesign(
                    c.id,
                    c.frame,
                    materializeDefaultProps(c.props),
                  )
                }
                caption={c.native ? "renders your live data" : undefined}
              >
                <button
                  onClick={() => onInsertComponent(c)}
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
              </PreviewHoverCard>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Community browse per §8: GET /v1/community/components?q=&category=&sort=.
 * `query` is the palette's single search box — typing debounces the server
 * call; mount, retry, sort, and category-facet clicks fire immediately.
 * Clicking any result's category chip filters to that slug; clicking it
 * again (or the active chip beside the heading) clears.
 *
 * The Favorites chip swaps the feed for GET /v1/components/favorites — one
 * fetch, then q/category/sort apply CLIENT-side (lib/favorites.ts mirrors
 * the server's matching rules), so typing never re-hits the server there.
 * Hearts flip optimistically and roll back on error; in Favorites view an
 * unfavorited row stays visible (heart hollow) until the next fetch so the
 * flip is undoable in place — no layout jump, no lost row.
 */
function CommunitySection({
  query,
  sort,
  signedIn,
  onInsert,
}: {
  query: string;
  sort: CommunitySort;
  signedIn: boolean;
  onInsert: (ref: string, def: ComponentDefinition) => void;
}) {
  const [category, setCategory] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [results, setResults] = useState<CommunityComponent[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** Ids with a favorite write in flight — their hearts are disabled. */
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  /** Last query this effect ran with — an unchanged query means the rerun
   * came from a click (facet/retry/sort/favorites), which shouldn't wait
   * out a debounce. */
  const lastQuery = useRef<string | null>(null);

  // Browse fetch — inert while the Favorites view is active (but the query
  // ref stays current so switching back never waits out a stale debounce).
  useEffect(() => {
    if (favoritesOnly) {
      lastQuery.current = query;
      return;
    }
    const controller = new AbortController();
    const delay = lastQuery.current === query || lastQuery.current === null ? 0 : 350;
    lastQuery.current = query;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        setResults(
          await listCommunity(query, category ?? undefined, sort, controller.signal),
        );
        setError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(toApiError(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, category, sort, attempt, favoritesOnly]);

  // Favorites fetch — one call per activation/retry; q/category/sort apply
  // client-side below, so typing never re-hits the server here.
  useEffect(() => {
    if (!favoritesOnly) return;
    const controller = new AbortController();
    setLoading(true);
    (async () => {
      try {
        setResults(await listFavoriteComponents(controller.signal));
        setError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(toApiError(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [favoritesOnly, attempt]);

  function toggleCategory(slug: string) {
    setCategory((prev) => (prev === slug ? null : slug));
  }

  /**
   * Optimistic heart flip: paint the target state, then converge with the
   * idempotent PUT/DELETE; roll the exact flip back if the write fails.
   */
  async function toggleFavorite(id: string, next: boolean) {
    const target = splitComponentId(id);
    if (!target || pendingIds.has(id)) return;
    setPendingIds((prev) => new Set(prev).add(id));
    setResults((prev) => (prev ? applyFavorite(prev, id, next) : prev));
    try {
      if (next) await favoriteComponent(target.owner, target.name);
      else await unfavoriteComponent(target.owner, target.name);
    } catch {
      setResults((prev) => (prev ? applyFavorite(prev, id, !next) : prev));
    } finally {
      setPendingIds((prev) => {
        const rest = new Set(prev);
        rest.delete(id);
        return rest;
      });
    }
  }

  const trimmed = query.trim();
  const normalized = normalizeQuery(query);
  // Favorites view composes q + category + sort client-side; browse rows
  // arrive already filtered and ordered by the server.
  const rows =
    results == null
      ? null
      : favoritesOnly
        ? sortFavoriteRows(
            filterFavoriteRows(results, normalized, category),
            sort,
          )
        : results;

  return (
    <>
      <div className="flex items-center justify-between gap-2 px-4 pt-1 pb-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Community
        </h2>
        <div className="flex min-w-0 items-center gap-1.5">
          {/* The facet's obvious "on" indicator — visible even when the
              filtered result list is empty, and a one-click clear. */}
          {category && (
            <CategoryChip
              category={category}
              active
              onToggle={() => setCategory(null)}
            />
          )}
          {/* Favorites filter: swaps browse for the personal favorites
              list. Needs a session, like the hearts it collects. */}
          {signedIn && (
            <button
              type="button"
              aria-pressed={favoritesOnly}
              title={
                favoritesOnly
                  ? "Show all community components"
                  : "Show only components you favorited"
              }
              onClick={() => setFavoritesOnly((prev) => !prev)}
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px font-mono text-[10px] leading-4",
                "transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                favoritesOnly
                  ? "border-rose-500 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20"
                  : "text-muted-foreground hover:border-ring hover:text-foreground",
              )}
            >
              <Heart
                aria-hidden
                className={cn("size-2.5", favoritesOnly && "fill-current")}
              />
              Favorites
            </button>
          )}
        </div>
      </div>
      <div className="space-y-2 px-3 pb-3">
        {error ? (
          <div className="space-y-2 rounded-lg border border-dashed p-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {favoritesOnly
                ? "Favorites unavailable."
                : "Community search unavailable."}
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
        ) : rows == null || loading ? (
          <p className="px-1 py-1 text-xs text-muted-foreground">Searching…</p>
        ) : rows.length === 0 ? (
          <p className="px-1 py-1 text-[11px] leading-relaxed text-muted-foreground">
            {favoritesOnly
              ? results != null && results.length > 0
                ? "None of your favorites match."
                : "No favorites yet — tap the heart on any community card."
              : trimmed === "" && category == null
                ? "No published community components yet."
                : category != null && trimmed !== ""
                  ? `Nothing in “${category}” matches “${trimmed}”.`
                  : category != null
                    ? `Nothing published in “${category}” yet.`
                    : `Nothing matches “${trimmed}”.`}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {rows
              .filter((c) => c.latestVersion > 0)
              .map((c) => (
                <li key={c.id}>
                  <UserComponentCard
                    id={c.id}
                    title={c.title}
                    subtitle={`by ${c.owner}`}
                    version={c.latestVersion}
                    category={c.category}
                    activeCategory={category}
                    onCategoryToggle={toggleCategory}
                    usageCount={c.usageCount}
                    favoriteCount={c.favoriteCount}
                    favorited={c.favorited === true}
                    favoritePending={pendingIds.has(c.id)}
                    onToggleFavorite={
                      signedIn
                        ? (next) => void toggleFavorite(c.id, next)
                        : undefined
                    }
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
 *
 * The category chip is display-only on my-components rows; community rows
 * pass onCategoryToggle, which renders it as a SIBLING button below the
 * insert button (never nested — a button inside a button is invalid), wired
 * as the browse category facet. Community rows also carry the §8 counts row
 * (♥ N · used in N projects) with the heart as the favorite toggle — again a
 * sibling of the insert button, in the same footer row so toggling never
 * changes the card's height.
 */
function UserComponentCard({
  id,
  title,
  subtitle,
  version,
  category,
  activeCategory,
  onCategoryToggle,
  usageCount,
  favoriteCount,
  favorited = false,
  favoritePending = false,
  onToggleFavorite,
  onInsert,
}: {
  id: string;
  title: string;
  subtitle: string;
  version: number;
  category?: string;
  /** Currently-active community facet (chip active state). */
  activeCategory?: string | null;
  onCategoryToggle?: (category: string) => void;
  /** §8 community counts; absent (my-components rows) hides the counts row. */
  usageCount?: number;
  favoriteCount?: number;
  favorited?: boolean;
  /** Favorite write in flight — the heart is disabled, never mid-flipped. */
  favoritePending?: boolean;
  /** Absent = signed out: the heart renders as a static count, not a toggle. */
  onToggleFavorite?: (next: boolean) => void;
  onInsert: (ref: string, def: ComponentDefinition) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = `${id}@${version}`;
  const facetChip = category != null && onCategoryToggle != null;
  const countsRow = usageCount !== undefined || favoriteCount !== undefined;
  const footer = facetChip || countsRow;

  async function insert() {
    if (busy) return;
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
    // Preview keys by the same pinned ref insertion uses, and resolves the
    // definition through the same version cache — hover then insert (or the
    // reverse) fetches the definition exactly once.
    <PreviewHoverCard
      title={title}
      previewKey={pinnedPreviewKey(id, version)}
      getDesign={async () => {
        const def = await getComponentVersionCached(ref);
        return buildInstancePreviewDesign(
          ref,
          def.frame,
          materializeDefaultProps(def.props),
        );
      }}
    >
      <div className="w-full rounded-lg border bg-background transition-colors hover:border-ring focus-within:border-ring">
        <button
          onClick={() => void insert()}
          disabled={busy}
          className={cn(
            "w-full px-3 py-2 text-left transition-colors hover:bg-muted",
            "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60",
            footer ? "rounded-t-lg" : "rounded-lg",
          )}
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
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
              {subtitle}
            </span>
            {category && !facetChip && <CategoryChip category={category} />}
          </div>
          {error && <div className="mt-1 text-[10px] text-destructive">{error}</div>}
        </button>
        {footer && (
          <div className="flex min-w-0 items-center gap-2 px-3 pb-2">
            {facetChip && (
              <CategoryChip
                category={category}
                active={category === activeCategory}
                onToggle={() => onCategoryToggle(category)}
              />
            )}
            {countsRow && (
              <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] tabular-nums text-muted-foreground">
                {onToggleFavorite ? (
                  <button
                    type="button"
                    aria-pressed={favorited}
                    aria-label={
                      favorited
                        ? `Remove ${title} from favorites`
                        : `Favorite ${title}`
                    }
                    title={favorited ? "Remove favorite" : "Favorite"}
                    disabled={favoritePending}
                    onClick={() => onToggleFavorite(!favorited)}
                    className={cn(
                      "-m-1 rounded-md p-1 transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60",
                      favorited
                        ? "text-rose-500 hover:text-rose-400"
                        : "hover:text-foreground",
                    )}
                  >
                    <Heart
                      aria-hidden
                      className={cn("size-3", favorited && "fill-current")}
                    />
                  </button>
                ) : (
                  // Signed out: counts stay visible, the toggle doesn't.
                  <Heart aria-hidden className="size-3" />
                )}
                <span>{favoriteCount ?? 0}</span>
                {(usageCount ?? 0) > 0 && (
                  <span>
                    · used in {usageCount}{" "}
                    {usageCount === 1 ? "project" : "projects"}
                  </span>
                )}
              </span>
            )}
          </div>
        )}
      </div>
    </PreviewHoverCard>
  );
}
