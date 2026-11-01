"use client";

import { useEffect, useId, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "./ui/Button";

type PlatformRole = "user" | "admin" | "super_admin";
type InternalProps = {
  kind: "internal";
  userId: Id<"users">;
  platformRole?: PlatformRole;
};
type ExternalProps = {
  kind: "external";
  approvedExternalUserId: Id<"approvedExternalUsers">;
  isCoordinator: boolean;
};

export function UserRolesEditor(props: InternalProps | ExternalProps) {
  return props.kind === "internal" ? (
    <InternalRoleSelect {...props} />
  ) : (
    <ExternalCoordinatorEditor {...props} />
  );
}

function InternalRoleSelect({
  userId,
  platformRole: initialRole,
}: InternalProps) {
  const id = useId();
  const saveRole = useMutation(api.data.internalUserAdmin.setInternalUserRoles);
  const [role, setRole] = useState<PlatformRole | "">(initialRole ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRole(initialRole ?? "");
    setError(null);
  }, [userId, initialRole]);

  const changeRole = async (nextRole: "user" | "admin") => {
    setRole(nextRole);
    setSaving(true);
    setError(null);
    try {
      await saveRole({ targetUserId: userId, platformRole: nextRole });
    } catch (error) {
      setRole(initialRole ?? "");
      setError(
        error instanceof Error ? error.message : "No se pudo guardar el rol.",
      );
    } finally {
      setSaving(false);
    }
  };

  const fieldClassName =
    "h-[38px] w-36 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
  return (
    <div className="flex flex-col items-end gap-1">
      <label htmlFor={id} className="sr-only">
        Rol del usuario
      </label>
      {initialRole === "super_admin" ? (
        <input
          id={id}
          value="Super admin"
          readOnly
          title="Este nivel se gestiona únicamente desde la base de datos."
          className={fieldClassName + " bg-muted"}
        />
      ) : (
        <select
          id={id}
          value={role}
          disabled={saving}
          aria-busy={saving}
          title="El rol se guarda al seleccionarlo."
          onChange={(event) => {
            const value = event.target.value;
            if (value === "user" || value === "admin") void changeRole(value);
          }}
          className={fieldClassName}
        >
          <option value="" disabled>
            Seleccionar rol
          </option>
          <option value="user">Usuario</option>
          <option value="admin">Admin</option>
        </select>
      )}
      <span role="status" className="sr-only">
        {saving ? "Guardando rol..." : ""}
      </span>
      {error && (
        <p
          role="alert"
          className="max-w-64 text-right text-xs text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  );
}

function ExternalCoordinatorEditor({
  approvedExternalUserId,
  isCoordinator: initialCoordinator,
}: ExternalProps) {
  const id = useId();
  const saveRole = useMutation(api.data.externalUserAdmin.setExternalUserRoles);
  const [isCoordinator, setIsCoordinator] = useState(initialCoordinator);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    error: boolean;
    text: string;
  } | null>(null);

  useEffect(() => {
    setIsCoordinator(initialCoordinator);
    setFeedback(null);
  }, [approvedExternalUserId, initialCoordinator]);

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      await saveRole({ approvedExternalUserId, isCoordinator });
      setFeedback({ error: false, text: "Roles guardados." });
    } catch (error) {
      setFeedback({
        error: true,
        text:
          error instanceof Error
            ? error.message
            : "No se pudieron guardar los roles.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-labelledby={id + "-title"}
      className="rounded-lg border border-border bg-card p-4"
    >
      <h3 id={id + "-title"} className="text-sm font-semibold text-foreground">
        Roles del usuario
      </h3>
      <div className="mt-4 space-y-4">
        <div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={isCoordinator}
              disabled={saving}
              onChange={(event) => setIsCoordinator(event.target.checked)}
              aria-describedby={id + "-coordinator-help"}
              className="h-4 w-4"
            />
            Coordinador externo
          </label>
          <p
            id={id + "-coordinator-help"}
            className="mt-1 text-xs text-muted-foreground"
          >
            Recibe notificaciones y correos de nuevas tareas y comentarios,
            únicamente en las tareas a las que tiene acceso.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            disabled={isCoordinator === initialCoordinator || saving}
            onClick={save}
          >
            {saving ? "Guardando..." : "Guardar roles"}
          </Button>
          {feedback && (
            <p
              role={feedback.error ? "alert" : "status"}
              className={
                "text-sm " +
                (feedback.error ? "text-destructive" : "text-muted-foreground")
              }
            >
              {feedback.text}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
