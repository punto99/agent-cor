"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { BarChart3, LogOut, UserCog, UserPlus } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "./ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/DropdownMenu";
import { useUser } from "../UserContextProvider";

export function UserMenu() {
  const { user, signOut } = useUser();
  const analyticsAccess = useQuery(api.data.analytics.viewerCanAccessAnalytics);
  const internalUserAdminAccess = useQuery(
    api.data.internalUserAdmin.viewerCanAccessInternalUserAdmin,
  );
  const externalUserAdminAccess = useQuery(
    api.data.externalUserAdmin.viewerCanAccessExternalUserAdmin,
  );
  const [imageError, setImageError] = useState(false);

  if (!user) return null;

  const initials = user.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : user.email?.charAt(0).toUpperCase() || "U";

  const showImage = user.image && !imageError;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="relative h-10 w-10 rounded-full bg-background/95 backdrop-blur-sm p-0 hover:cursor-pointer"
        >
          {showImage ? (
            <div className="relative h-9 w-9 rounded-full overflow-hidden">
              <img
                src={user.image!}
                alt={user.name || user.email || "User"}
                className="h-full w-full object-cover"
                onError={() => setImageError(true)}
              />
            </div>
          ) : (
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground font-medium text-sm">
              {initials}
            </div>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="end" forceMount>
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            {user.name && (
              <p className="text-sm font-medium leading-none">{user.name}</p>
            )}
            {user.email && (
              <p className="text-xs leading-none text-muted-foreground">
                {user.email}
              </p>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {analyticsAccess?.canAccess && (
          <>
            <DropdownMenuItem asChild className="cursor-pointer">
              <Link href="/workspace/analytics">
                <BarChart3 className="mr-2 h-4 w-4" />
                <span>Analytics</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {internalUserAdminAccess?.canAccess && (
          <>
            <DropdownMenuItem asChild className="cursor-pointer">
              <Link href="/workspace/users">
                <UserCog className="mr-2 h-4 w-4" />
                <span>Usuarios internos</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {externalUserAdminAccess?.canAccess && (
          <>
            <DropdownMenuItem asChild className="cursor-pointer">
              <Link href="/workspace/external-users">
                <UserPlus className="mr-2 h-4 w-4" />
                <span>Usuarios externos</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={signOut} className="cursor-pointer">
          <LogOut className="mr-2 h-4 w-4" />
          <span>Cerrar sesión</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
