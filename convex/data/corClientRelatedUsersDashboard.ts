import { action } from "../_generated/server";
import { v } from "convex/values";

const COR_API_BASE_URL = "https://api.projectcor.com/v1";
const MAX_PROJECT_PAGES = 200;
const PROJECTS_PAGE_SIZE = 100;

type CORListResponse = {
  data?: unknown[];
  files?: unknown[];
  meta?: {
    current_page?: number;
    last_page?: number;
    next_page?: number | null;
  };
  current_page?: number;
  last_page?: number;
  next_page?: number | null;
  page?: number;
  total_pages?: number;
};

type RelatedUser = {
  id?: number;
  email?: string;
  firstName?: string;
  lastName?: string;
  fullName: string;
  roleId?: number;
  positionName?: string;
};

async function getCORAccessToken(): Promise<string> {
  const apiKey = process.env.COR_API_KEY;
  const clientSecret = process.env.COR_CLIENT_SECRET;

  if (!apiKey || !clientSecret) {
    throw new Error(
      "COR credentials not configured. Set COR_API_KEY and COR_CLIENT_SECRET in Convex dashboard."
    );
  }

  const credentials = btoa(`${apiKey}:${clientSecret}`);
  const response = await fetch(
    `${COR_API_BASE_URL}/oauth/token?grant_type=client_credentials`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
      },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`COR auth failed: ${response.status} - ${errorText}`);
  }

  const tokenData = (await response.json()) as { access_token: string };
  return tokenData.access_token;
}

async function corApiFetch(
  path: string,
  token: string,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(`${COR_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...((options.headers as Record<string, string>) || {}),
    },
  });
}

function extractList(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  const asObj = parsed as CORListResponse;
  if (Array.isArray(asObj.data)) return asObj.data;
  if (Array.isArray(asObj.files)) return asObj.files;
  return [];
}

function hasNextPage(parsed: unknown, currentPage: number, itemCount: number): boolean {
  const asObj = parsed as CORListResponse;

  if (asObj?.meta?.next_page !== undefined) {
    return asObj.meta.next_page !== null;
  }
  if (asObj?.next_page !== undefined) {
    return asObj.next_page !== null;
  }

  const lastPage = asObj?.meta?.last_page ?? asObj?.last_page ?? asObj?.total_pages;
  const page = asObj?.meta?.current_page ?? asObj?.current_page ?? asObj?.page ?? currentPage;
  if (typeof lastPage === "number" && typeof page === "number") {
    return page < lastPage;
  }

  return itemCount >= PROJECTS_PAGE_SIZE;
}

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeName(firstName?: string, lastName?: string, fallback?: string): string {
  const full = `${firstName || ""} ${lastName || ""}`.trim();
  if (full) return full;
  if (fallback && fallback.trim()) return fallback.trim();
  return "Usuario sin nombre";
}

function normalizeCollaborator(raw: unknown): RelatedUser | null {
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "number" ? item.id : undefined;
  const email = normalizeEmail(item.email);
  const firstName = typeof item.first_name === "string"
    ? item.first_name
    : typeof item.firstName === "string"
      ? item.firstName
      : undefined;
  const lastName = typeof item.last_name === "string"
    ? item.last_name
    : typeof item.lastName === "string"
      ? item.lastName
      : undefined;
  const fullNameRaw = typeof item.name === "string"
    ? item.name
    : typeof item.full_name === "string"
      ? item.full_name
      : undefined;

  if (!id && !email && !firstName && !lastName && !fullNameRaw) {
    return null;
  }

  return {
    id,
    email,
    firstName,
    lastName,
    fullName: normalizeName(firstName, lastName, fullNameRaw),
    roleId: typeof item.role_id === "number" ? item.role_id : undefined,
    positionName:
      typeof item.position_name === "string" ? item.position_name : undefined,
  };
}

function extractProjectId(project: unknown): number | null {
  const p = project as Record<string, unknown>;
  const id =
    typeof p.id === "number"
      ? p.id
      : typeof p.project_id === "number"
        ? p.project_id
        : null;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

function extractProjectClientId(project: unknown): number | null {
  const p = project as Record<string, unknown>;
  const clientId =
    typeof p.client_id === "number"
      ? p.client_id
      : typeof p.clientId === "number"
        ? p.clientId
        : null;
  return typeof clientId === "number" && Number.isFinite(clientId)
    ? clientId
    : null;
}

async function fetchProjectsPage(
  token: string,
  clientId: number,
  page: number,
  preferredFilterMode?: "array" | "object" | "bracket"
): Promise<{ projects: unknown[]; hasNext: boolean; filterMode: "array" | "object" | "bracket" }> {
  const filterModes: Array<"array" | "object" | "bracket"> = preferredFilterMode
    ? [preferredFilterMode]
    : ["object", "array", "bracket"];

  let lastError: string | null = null;

  for (const mode of filterModes) {
    const filters =
      mode === "array"
        ? encodeURIComponent(JSON.stringify([{ name: "client_id", value: clientId }]))
        : mode === "object"
          ? encodeURIComponent(JSON.stringify({ client_id: clientId }))
          : "";

    const path =
      mode === "bracket"
        ? `/projects?page=${page}&perPage=${PROJECTS_PAGE_SIZE}&filters[client_id]=${clientId}`
        : `/projects?page=${page}&perPage=${PROJECTS_PAGE_SIZE}&filters=${filters}`;

    const response = await corApiFetch(path, token);

    if (!response.ok) {
      lastError = `${response.status} (${mode})`;
      continue;
    }

    const raw = await response.text();
    if (!raw.trim()) {
      return { projects: [], hasNext: false, filterMode: mode };
    }

    const parsed = JSON.parse(raw);
    const projects = extractList(parsed);
    const mismatchedClientProjects = projects.filter((project) => {
      const projectClientId = extractProjectClientId(project);
      return projectClientId !== null && projectClientId !== clientId;
    });

    if (mismatchedClientProjects.length > 0) {
      lastError = `Filtro ignorado (${mode}): ${mismatchedClientProjects.length} proyecto(s) de otro cliente`;
      continue;
    }

    return {
      projects,
      hasNext: hasNextPage(parsed, page, projects.length),
      filterMode: mode,
    };
  }

  throw new Error(
    `No se pudo obtener proyectos filtrados por client_id=${clientId}. Último error: ${lastError || "desconocido"}`
  );
}

async function fetchProjectCollaborators(token: string, projectId: number): Promise<unknown[]> {
  const response = await corApiFetch(`/projects/${projectId}/collaborators`, token);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Error obteniendo colaboradores para proyecto ${projectId}: ${response.status} - ${errorText}`
    );
  }

  const raw = await response.text();
  if (!raw.trim()) return [];

  const parsed = JSON.parse(raw);
  return extractList(parsed);
}

export const listClientRelatedUsersFromCOR = action({
  args: {
    clientName: v.string(),
  },
  handler: async (_ctx, args): Promise<RelatedUser[]> => {
    const requestedName = args.clientName.trim();
    if (!requestedName) {
      throw new Error("Debes enviar un nombre de cliente válido.");
    }

    const token = await getCORAccessToken();

    const searchResponse = await corApiFetch(
      `/clients/search-by-name/${encodeURIComponent(requestedName)}`,
      token
    );

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();
      throw new Error(
        `Error buscando cliente por nombre: ${searchResponse.status} - ${errorText}`
      );
    }

    const searchRaw = await searchResponse.text();
    const clients = searchRaw.trim() ? extractList(JSON.parse(searchRaw)) : [];

    if (clients.length === 0) {
      throw new Error(`No se encontró cliente con nombre "${requestedName}" en COR.`);
    }

    const exactClient = clients.find((c) => {
      const item = c as Record<string, unknown>;
      const name = typeof item.name === "string" ? item.name.trim().toLowerCase() : "";
      return name === requestedName.toLowerCase();
    }) as Record<string, unknown> | undefined;

    const selectedClient = (exactClient || (clients[0] as Record<string, unknown>));
    const clientId = typeof selectedClient.id === "number" ? selectedClient.id : null;

    if (!clientId) {
      throw new Error("El cliente encontrado no tiene id válido en COR.");
    }

    const projectIds = new Set<number>();
    let page = 1;
    let hasNext = true;
    let filterMode: "array" | "object" | "bracket" | undefined;

    while (hasNext && page <= MAX_PROJECT_PAGES) {
      const pageResult = await fetchProjectsPage(token, clientId, page, filterMode);
      filterMode = pageResult.filterMode;

      for (const project of pageResult.projects) {
        const projectId = extractProjectId(project);
        if (projectId !== null) projectIds.add(projectId);
      }

      hasNext = pageResult.hasNext;
      page += 1;
    }

    const seenIds = new Set<number>();
    const seenEmails = new Set<string>();
    const uniqueUsers: RelatedUser[] = [];

    for (const projectId of projectIds) {
      const collaborators = await fetchProjectCollaborators(token, projectId);

      for (const raw of collaborators) {
        const user = normalizeCollaborator(raw);
        if (!user) continue;

        const hasKnownId = typeof user.id === "number";
        const hasKnownEmail = typeof user.email === "string";

        if (hasKnownId && seenIds.has(user.id!)) continue;
        if (hasKnownEmail && seenEmails.has(user.email!)) continue;

        if (hasKnownId) seenIds.add(user.id!);
        if (hasKnownEmail) seenEmails.add(user.email!);

        uniqueUsers.push(user);
      }
    }

    uniqueUsers.sort((a, b) => a.fullName.localeCompare(b.fullName, "es", { sensitivity: "base" }));
    return uniqueUsers;
  },
});
