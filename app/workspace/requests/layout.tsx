"use client";

import { CommentNotificationBell } from "@/app/components/notifications/CommentNotifications";
import { useEffect } from "react";
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { BrandLogo } from "@/app/components/BrandLogo";
import { TopNavigation } from "@/app/components/TopNavigation";
import { UserMenu } from "@/app/components/UserMenu";
import { SwitchThemeButton } from "@/app/components/ui/SwitchThemeButton";
import { LoadingScreen } from "@/app/components/LoadingScreen";

export default function RequestsLayout({ children }: { children: React.ReactNode }) {
  const profile = useQuery(api.data.userAccess.viewerAccessProfile);
  const router = useRouter();

  useEffect(() => {
    if (profile && (profile.kind !== "external" || !profile.canAccessExternalRequests)) {
      router.replace(profile.isAuthenticated ? "/workspace" : "/login");
    }
  }, [profile, router]);

  if (profile?.kind !== "external" || !profile.canAccessExternalRequests) return <LoadingScreen />;

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-4 py-4 sm:px-8">
        <BrandLogo />
        <div className="flex items-center gap-3"><CommentNotificationBell /><UserMenu /><SwitchThemeButton /></div>
      </header>
      <TopNavigation />
      <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
