"use client";

import { useEffect, useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import {
  getErrorMessage,
  type InternalClient,
  type InternalUser,
  type InternalUserStatus,
  type InternalUsersToast,
} from "@/app/lib/internalUsers";

const EMPTY_USERS: InternalUser[] = [];
const EMPTY_CLIENTS: InternalClient[] = [];

export function useInternalUsersAdmin() {
  const router = useRouter();
  const access = useQuery(
    api.data.internalUserAdmin.viewerCanAccessInternalUserAdmin,
  );
  const dashboard = useQuery(api.data.internalUserAdmin.getDashboard);
  const resolveInCOR = useAction(
    api.data.internalUserAdminActions.resolveInternalUserInCORNow,
  );
  const verifyInCOR = useAction(
    api.data.internalUserAdminActions.verifyInternalUserInCORNow,
  );
  const [search, setSearch] = useState("");
  const [userStatus, setUserStatus] = useState<InternalUserStatus>("active");
  const [selectedUserId, setSelectedUserId] = useState<
    InternalUser["_id"] | null
  >(null);
  const [resolvingUserId, setResolvingUserId] = useState<
    InternalUser["_id"] | null
  >(null);
  const [verifyingUserId, setVerifyingUserId] = useState<
    InternalUser["_id"] | null
  >(null);
  const [toast, setToast] = useState<InternalUsersToast | null>(null);

  useEffect(() => {
    if (access && !access.canAccess) router.replace("/workspace");
  }, [access, router]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const users = dashboard?.canAccess ? dashboard.users : EMPTY_USERS;
  const clients = dashboard?.canAccess ? dashboard.clients : EMPTY_CLIENTS;
  const activeUsers = useMemo(
    () => users.filter((user) => user.corUser?.isActive !== false),
    [users],
  );
  const inactiveUsers = useMemo(
    () => users.filter((user) => user.corUser?.isActive === false),
    [users],
  );
  const visibleUsers = useMemo(() => {
    const term = search.trim().toLowerCase();
    const statusUsers = userStatus === "active" ? activeUsers : inactiveUsers;
    if (!term) return statusUsers;
    return statusUsers.filter(
      (user) =>
        user.name.toLowerCase().includes(term) ||
        user.email.toLowerCase().includes(term),
    );
  }, [search, userStatus, activeUsers, inactiveUsers]);

  const selectedUser =
    visibleUsers.find((user) => user._id === selectedUserId) ??
    visibleUsers[0] ??
    null;

  useEffect(() => {
    setSelectedUserId(selectedUser?._id ?? null);
  }, [selectedUser?._id]);

  const summary = useMemo(
    () => ({
      completeUsers: activeUsers.filter((user) => user.isCompleteForBrief)
        .length,
      missingCor: activeUsers.filter((user) => !user.corUser).length,
      missingPermissions: activeUsers.filter(
        (user) => user.corUser && user.assignments.length === 0,
      ).length,
    }),
    [activeUsers],
  );

  async function runCorAction(mode: "resolve" | "verify") {
    if (!selectedUser || selectedUser.corUser?.isActive === false) return;
    const isResolving = mode === "resolve";
    const setPendingUserId = isResolving
      ? setResolvingUserId
      : setVerifyingUserId;
    const action = isResolving ? resolveInCOR : verifyInCOR;
    try {
      setPendingUserId(selectedUser._id);
      const result = await action({ targetUserId: selectedUser._id });
      if (!result.ok) {
        setToast({ type: "error", message: result.error });
        return;
      }
      setToast({
        type: "success",
        message: `Usuario ${isResolving ? "validado" : "verificado"} en COR: ${result.name || result.email || result.corUserId}.`,
      });
    } catch (error) {
      setToast({
        type: "error",
        message: getErrorMessage(
          error,
          isResolving
            ? "No se pudo validar el usuario en COR."
            : "No se pudo verificar el usuario en COR.",
        ),
      });
    } finally {
      setPendingUserId(null);
    }
  }

  return {
    isLoading: !access?.canAccess || !dashboard?.canAccess,
    clients,
    search,
    setSearch,
    userStatus,
    setUserStatus,
    activeCount: activeUsers.length,
    inactiveCount: inactiveUsers.length,
    visibleUsers,
    selectedUser,
    setSelectedUserId,
    summary,
    toast,
    setToast,
    isResolving: Boolean(selectedUser && resolvingUserId === selectedUser._id),
    isVerifying: Boolean(selectedUser && verifyingUserId === selectedUser._id),
    resolveInCOR: () => runCorAction("resolve"),
    verifyInCOR: () => runCorAction("verify"),
  };
}
