"use client";

import { useMutation, usePaginatedQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useInternalUsersAdmin } from "@/app/hooks/useInternalUsersAdmin";
import { useInternalUserPermissions } from "@/app/hooks/useInternalUserPermissions";
import { LoadingScreen } from "../LoadingScreen";
import { WorkspaceLayout } from "../WorkspaceLayout";
import { InternalUsersHeader } from "./InternalUsersHeader";
import { InternalUsersSidebar } from "./InternalUsersSidebar";
import { InternalUserProfile } from "./InternalUserProfile";
import { InactiveUserPanel } from "./InactiveUserPanel";
import { UserPermissionsEditor } from "./UserPermissionsEditor";

export function InternalUsersAdmin() {
  const router = useRouter();
  const {
    isLoading,
    clients,
    search,
    setSearch,
    userStatus,
    setUserStatus,
    activeCount,
    inactiveCount,
    visibleUsers,
    selectedUser,
    setSelectedUserId,
    summary,
    toast,
    setToast,
    isResolving,
    isVerifying,
    resolveInCOR,
    verifyInCOR,
  } = useInternalUsersAdmin();
  const permissions = useInternalUserPermissions(
    selectedUser,
    clients,
    setToast,
  );
  const {
    results: threads,
    status: threadsStatus,
    loadMore,
  } = usePaginatedQuery(
    api.messaging.threads.getMyThreads,
    {},
    { initialNumItems: 20 },
  );
  const createThread = useMutation(api.messaging.threads.createThread);

  async function handleNewThread() {
    await createThread({
      title: `Nuevo chat • ${new Date().toLocaleString()}`,
    });
    router.push("/workspace");
  }

  if (isLoading || threadsStatus === "LoadingFirstPage") {
    return <LoadingScreen />;
  }

  return (
    <WorkspaceLayout
      threads={threads}
      threadsStatus={threadsStatus}
      loadMoreThreads={loadMore}
      onNewThread={handleNewThread}
      onSelectThread={() => router.push("/workspace")}
    >
      <div className="h-full flex flex-col bg-background">
        <InternalUsersHeader summary={summary} />

        {toast && (
          <div
            className={`mx-6 mt-4 rounded-md border px-4 py-3 text-sm ${
              toast.type === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
                : "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
            }`}
          >
            {toast.message}
          </div>
        )}

        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[320px_1fr]">
          <InternalUsersSidebar
            search={search}
            onSearchChange={setSearch}
            userStatus={userStatus}
            onStatusChange={setUserStatus}
            activeCount={activeCount}
            inactiveCount={inactiveCount}
            users={visibleUsers}
            selectedUserId={selectedUser?._id ?? null}
            onSelectUser={setSelectedUserId}
          />

          <main className="min-h-0 overflow-y-auto">
            {!selectedUser ? (
              <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 px-6 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Search className="h-5 w-5" aria-hidden="true" />
                </div>
                <p className="text-sm text-muted-foreground">
                  {search.trim()
                    ? "No encontramos usuarios con esa búsqueda."
                    : `No hay usuarios ${userStatus === "active" ? "activos" : "inactivos"} para mostrar.`}
                </p>
              </div>
            ) : selectedUser.corUser?.isActive === false ? (
              <div className="max-w-6xl p-6">
                <InactiveUserPanel user={selectedUser} />
              </div>
            ) : (
              <div className="p-6 max-w-6xl space-y-5">
                <InternalUserProfile
                  user={selectedUser}
                  isResolving={isResolving}
                  isVerifying={isVerifying}
                  onResolve={resolveInCOR}
                  onVerify={verifyInCOR}
                />
                <UserPermissionsEditor {...permissions} />
              </div>
            )}
          </main>
        </div>
      </div>
    </WorkspaceLayout>
  );
}
