import { useEffect, useState } from "react";
import { Landing } from "./components/Landing";
import { ProjectList } from "./components/ProjectList";
import { Editor } from "./components/Editor";
import { ComponentList } from "./components/ComponentList";
import { ComponentStudio } from "./components/ComponentStudio";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getMe, toApiError, type ApiError, type Me } from "@/lib/api";

/**
 * Boot resolves the session once (GET /v1/me): 401 lands on the sign-in hero,
 * anything else signed-in keeps the hand-rolled view switch (no router at
 * this size) — two sections (Projects | Components), each a list view that
 * opens its editing view: project list → editor, component list → studio.
 */
type Boot =
  | { phase: "loading" }
  | { phase: "landing"; error: ApiError | null }
  | { phase: "ready"; me: Me };

type Route =
  | { view: "list" }
  | { view: "editor"; projectId: string }
  | { view: "components" }
  | { view: "studio"; componentId: string };

export default function App() {
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [route, setRoute] = useState<Route>({ view: "list" });

  useEffect(() => {
    const controller = new AbortController();
    setBoot({ phase: "loading" });
    (async () => {
      try {
        const me = await getMe(controller.signal);
        setBoot({ phase: "ready", me });
      } catch (e) {
        if (controller.signal.aborted) return;
        const err = toApiError(e);
        // 401 is the signed-out path; anything else is surfaced on the hero.
        setBoot({ phase: "landing", error: err.status === 401 ? null : err });
      }
    })();
    return () => controller.abort();
  }, [attempt]);

  if (boot.phase === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (boot.phase === "landing") {
    return (
      <Landing error={boot.error} onRetry={() => setAttempt((n) => n + 1)} />
    );
  }

  const navigate = (section: "projects" | "components") =>
    setRoute(section === "projects" ? { view: "list" } : { view: "components" });

  return (
    <TooltipProvider>
      {route.view === "list" ? (
        <ProjectList
          me={boot.me}
          onNavigate={navigate}
          onOpen={(projectId) => setRoute({ view: "editor", projectId })}
        />
      ) : route.view === "editor" ? (
        <Editor
          // Remount per project so editor state can never leak across projects.
          key={route.projectId}
          me={boot.me}
          projectId={route.projectId}
          onBack={() => setRoute({ view: "list" })}
        />
      ) : route.view === "components" ? (
        <ComponentList
          me={boot.me}
          onNavigate={navigate}
          onOpen={(componentId) => setRoute({ view: "studio", componentId })}
        />
      ) : (
        <ComponentStudio
          // Remount per component — same isolation rule as the editor.
          key={route.componentId}
          me={boot.me}
          componentId={route.componentId}
          onBack={() => setRoute({ view: "components" })}
        />
      )}
    </TooltipProvider>
  );
}
