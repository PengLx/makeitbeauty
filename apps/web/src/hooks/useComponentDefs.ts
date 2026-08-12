/**
 * Pinned community-component definitions, cached per ref in a module map.
 *
 * A design references user components as "{owner}/{name}@{n}" — an immutable
 * published version — so a definition fetched once is valid for the process
 * lifetime: the cache never invalidates. Both consumers share it — the
 * palette fetches at insert time (to size the instance and seed defaults),
 * and the editor hydrates every ref its design mentions so the inspector can
 * render typed prop inputs exactly like kit instances.
 */

import { useEffect, useState } from "react";
import { getComponentVersion } from "@/lib/api";
import type { ComponentDefinition } from "@/lib/component";

const REF_RE = /^([a-z0-9-]+)\/([a-z0-9-]+)@([0-9]+)$/;

const cache = new Map<string, Promise<ComponentDefinition>>();

/**
 * Resolve a pinned ref ("{owner}/{name}@{n}") to its immutable definition.
 * Failures evict the entry so a transient API outage doesn't poison the ref
 * forever.
 */
export function getComponentVersionCached(
  ref: string,
): Promise<ComponentDefinition> {
  const existing = cache.get(ref);
  if (existing) return existing;
  const match = REF_RE.exec(ref);
  if (!match) {
    return Promise.reject(
      new Error(`"${ref}" is not a pinned component ref ({owner}/{name}@{n})`),
    );
  }
  const promise = getComponentVersion(match[1], match[2], Number(match[3]));
  promise.catch(() => cache.delete(ref));
  cache.set(ref, promise);
  return promise;
}

/**
 * Definitions for every pinned ref in `refs`, filling in as fetches land.
 * Unknown/unpublished refs simply never appear — the canvas keeps its dashed
 * placeholder and the inspector its metadata-unavailable note, matching how
 * the renderer degrades (§5.7: warning + placeholder, never a failure).
 */
export function useComponentDefs(
  refs: readonly string[],
): Map<string, ComponentDefinition> {
  const [loaded, setLoaded] = useState<Map<string, ComponentDefinition>>(
    () => new Map(),
  );
  // Effect key: the sorted ref set, so node moves/edits don't refire it.
  const key = [...refs].sort().join("\n");

  useEffect(() => {
    let cancelled = false;
    for (const ref of key === "" ? [] : key.split("\n")) {
      getComponentVersionCached(ref)
        .then((def) => {
          if (cancelled) return;
          setLoaded((prev) => {
            if (prev.get(ref) === def) return prev;
            return new Map(prev).set(ref, def);
          });
        })
        .catch(() => {
          /* degrade to placeholder; a later mount retries via the evicted cache */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [key]);

  return loaded;
}
