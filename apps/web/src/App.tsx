import { useState } from "react";
import { ProjectList } from "./components/ProjectList";
import { Editor } from "./components/Editor";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Hand-rolled two-view switch (no router at this size): the project list is
 * home; opening a project swaps in the editor for that id.
 */
type Route = { view: "list" } | { view: "editor"; projectId: string };

export default function App() {
  const [route, setRoute] = useState<Route>({ view: "list" });

  return (
    <TooltipProvider>
      {route.view === "list" ? (
        <ProjectList
          onOpen={(projectId) => setRoute({ view: "editor", projectId })}
        />
      ) : (
        <Editor
          // Remount per project so editor state can never leak across projects.
          key={route.projectId}
          projectId={route.projectId}
          onBack={() => setRoute({ view: "list" })}
        />
      )}
    </TooltipProvider>
  );
}
