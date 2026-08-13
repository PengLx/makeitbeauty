import { ARCHITECTURE_URL, LICENSE_URL, REPO_URL, SECURITY_URL } from "./links";

const LINKS = [
  { href: REPO_URL, label: "GitHub" },
  { href: ARCHITECTURE_URL, label: "Architecture" },
  { href: SECURITY_URL, label: "Security" },
  { href: LICENSE_URL, label: "MIT license" },
] as const;

export function LandingFooter() {
  return (
    <footer className="border-t border-white/10 py-10">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-5 text-sm text-slate-500 sm:flex-row sm:px-8">
        <p className="font-heading font-medium text-slate-400">MakeItBeauty</p>
        <nav aria-label="Footer">
          <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            {LINKS.map((l) => (
              <li key={l.label}>
                <a
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                  className="transition-colors hover:text-slate-300"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <p>MIT licensed</p>
      </div>
    </footer>
  );
}
