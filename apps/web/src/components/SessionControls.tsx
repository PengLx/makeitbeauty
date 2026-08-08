import { useState } from "react";
import { ChevronDown, LogOut } from "lucide-react";
import { logout, type Me } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DataDialog } from "./DataDialog";

interface Props {
  me: Me;
}

/** Avatar image when the API provides one, else the login's initial. */
function Avatar({ me }: { me: Me }) {
  const { login, avatarUrl } = me.user;
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        className="size-5 shrink-0 rounded-full border"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold uppercase text-secondary-foreground"
    >
      {login.slice(0, 1) || "?"}
    </span>
  );
}

/**
 * Right side of the header once /v1/me resolves: the "Data" connectors dialog
 * plus either the user menu or — under the dev fallback (me.dev, no GitHub
 * App configured) — a subtle badge, since there's no real session to sign out.
 */
export function SessionControls({ me }: Props) {
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
    } catch {
      /* session may already be gone; the reload below re-resolves /v1/me */
    }
    window.location.reload();
  }

  return (
    <>
      <DataDialog dev={me.dev === true} />
      {me.dev ? (
        <span className="rounded-full border border-dashed px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          dev mode
        </span>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              <Avatar me={me} />
              {me.user.login}
              <ChevronDown className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-44">
            <DropdownMenuLabel>
              {me.user.displayName || me.user.login}
              <span className="block font-normal text-muted-foreground">
                @{me.user.login}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={signingOut}
              onSelect={(e) => {
                e.preventDefault(); // keep the menu up while the POST runs
                void signOut();
              }}
            >
              <LogOut className="text-muted-foreground" />
              {signingOut ? "Signing out…" : "Sign out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}
