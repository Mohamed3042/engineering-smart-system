import { Suspense } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { cn } from "@/lib/cn";
import { PageLoading } from "@/ui";
import { SETTINGS_NAV } from "./nav";

/** Settings: grouped sub-navigation on the left (desktop) or as a list (phone, on /settings). */
export function SettingsLayout() {
  const { pathname } = useLocation();
  const atRoot = pathname === "/settings" || pathname === "/settings/";

  return (
    <div className="mx-auto w-full max-w-[1360px] px-4 pb-24 pt-5 sm:px-6 md:pb-12 md:pt-10 lg:px-10">
      <div className="lg:grid lg:grid-cols-[232px_1fr] lg:gap-10">
        <nav aria-label="Settings" className={cn("mb-6 lg:mb-0 lg:block", atRoot ? "block" : "hidden")}>
          <h1 className="mb-5 text-[1.75rem] font-bold tracking-[-0.01em] text-ink md:text-4xl lg:mb-6 lg:text-2xl">Settings</h1>
          <div className="space-y-6">
            {SETTINGS_NAV.map((group) => (
              <div key={group.title}>
                <p className="mb-1.5 px-3 text-xs font-semibold text-ink-3">{group.title}</p>
                <ul className="space-y-0.5">
                  {group.items.map(({ to, label, icon: Icon }) => (
                    <li key={to}>
                      <NavLink
                        to={to}
                        className={({ isActive }) =>
                          cn(
                            "flex h-11 items-center gap-3 rounded-lg px-3 text-[0.9375rem] font-medium transition-colors lg:h-10",
                            isActive ? "bg-brand-soft text-brand-ink" : "text-ink-2 hover:bg-hover hover:text-ink",
                          )
                        }
                      >
                        <Icon className="size-[18px] shrink-0" aria-hidden />
                        {label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>
        <div className={cn("min-w-0", atRoot && "hidden lg:block")}>
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
