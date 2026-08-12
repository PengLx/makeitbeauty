import { cn } from "@/lib/utils";

export type Section = "projects" | "components";

/**
 * Header section switch (Projects | Components) — the app's hand-rolled view
 * state machine grew a second top-level section, still no router. Styled like
 * a TabsList so it reads as navigation, not as an editor control.
 */
export function SectionNav({
  active,
  onNavigate,
}: {
  active: Section;
  onNavigate: (section: Section) => void;
}) {
  const item = (section: Section, label: string) => (
    <button
      type="button"
      aria-current={active === section ? "page" : undefined}
      onClick={() => {
        if (active !== section) onNavigate(section);
      }}
      className={cn(
        "h-6 rounded-md px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active === section
          ? "bg-background text-foreground shadow-sm dark:bg-input/50"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <nav
      aria-label="Sections"
      className="inline-flex h-7 items-center rounded-lg bg-muted p-0.5"
    >
      {item("projects", "Projects")}
      {item("components", "Components")}
    </nav>
  );
}
