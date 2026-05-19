"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { BarChart3, MessageSquare, LayoutDashboard } from "lucide-react";

/**
 * Navegación superior con tabs: Chat y Panel de Control.
 * Se muestra debajo del header en el WorkspaceLayout.
 */
export function TopNavigation() {
  const pathname = usePathname();
  const accessProfile = useQuery(api.data.userAccess.viewerAccessProfile);
  const analyticsAccess = useQuery(api.data.analytics.viewerCanAccessAnalytics);
  const isExternalUser = accessProfile?.kind === "external";

  const tabs = [
    {
      label: "Chat",
      href: "/workspace",
      icon: MessageSquare,
      isActive: pathname === "/workspace",
    },
    {
      label: "Panel de Control",
      href: "/workspace/control-panel",
      icon: LayoutDashboard,
      isActive: pathname === "/workspace/control-panel",
    },
    {
      label: "Analytics",
      href: "/workspace/analytics",
      icon: BarChart3,
      isActive: pathname === "/workspace/analytics",
    },
  ].filter((tab) => {
    if (isExternalUser && tab.href === "/workspace/control-panel") return false;
    if (tab.href === "/workspace/analytics") {
      return analyticsAccess?.canAccess === true;
    }
    return true;
  });

  return (
    <nav className="border-b border-border bg-card flex-shrink-0">
      <div className="flex items-center gap-1 px-4">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`
                flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors relative
                ${
                  tab.isActive
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                }
              `}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
              {/* Active indicator */}
              {tab.isActive && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t-full" />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
