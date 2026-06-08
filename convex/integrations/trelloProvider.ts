const TRELLO_API_BASE_URL = "https://api.trello.com/1";
const TRELLO_CLIENT_IDENTIFIER = "agent-core-convex-trello-sync";

type TrelloList = {
  id: string;
  name: string;
  closed?: boolean;
};

type TrelloCard = {
  id: string;
  name: string;
  url: string;
  shortUrl?: string;
  idList: string;
};

type TrelloComment = {
  id: string;
  type?: string;
  date?: string;
};

type TrelloCustomField = {
  id: string;
  type: string;
  name?: string;
  display?: {
    name?: string;
  };
};

type TrelloLabel = {
  id: string;
  idBoard: string;
  name: string;
  color: string | null;
};

type TrelloAttachment = {
  id: string;
  name: string;
  url: string;
};

type TrelloDownloadedAttachment = {
  blob: Blob;
  filename: string;
  mimeType: string;
  size?: number;
  url: string;
};

type TrelloWebhook = {
  id: string;
  active: boolean;
  callbackURL: string;
  idModel: string;
  description?: string;
};

type TrelloMember = {
  id: string;
  username?: string;
  fullName?: string;
  email?: string;
  memberType?: string;
  confirmed?: boolean;
};

type TrelloBoard = {
  id: string;
  name: string;
  url?: string;
  shortUrl?: string;
  closed?: boolean;
};

function getCredentials() {
  const key = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;

  if (!key || !token) {
    throw new Error("TRELLO_API_KEY y TRELLO_TOKEN deben estar configurados en Convex.");
  }

  return { key, token };
}

async function trelloFetch<T>(
  path: string,
  options: RequestInit = {},
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  const { key, token } = getCredentials();
  const url = new URL(`${TRELLO_API_BASE_URL}${path}`);
  url.searchParams.set("key", key);
  url.searchParams.set("token", token);

  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }

  const headers = new Headers(options.headers);
  headers.set("X-Trello-Client-Identifier", TRELLO_CLIENT_IDENTIFIER);

  const response = await fetch(url, {
    ...options,
    headers,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Trello API error: ${response.status} ${body}`);
  }

  return (await response.json()) as T;
}

async function trelloFetchBlob(
  urlOrPath: string,
): Promise<{
  blob: Blob;
  mimeType: string;
  size?: number;
  url: string;
}> {
  const { key, token } = getCredentials();
  const url = urlOrPath.startsWith("http")
    ? new URL(urlOrPath)
    : new URL(`${TRELLO_API_BASE_URL}${urlOrPath}`);

  const headers = new Headers();
  headers.set("X-Trello-Client-Identifier", TRELLO_CLIENT_IDENTIFIER);
  const isTrelloDownloadUrl =
    (url.hostname === "api.trello.com" || url.hostname === "trello.com") &&
    url.pathname.includes("/attachments/") &&
    url.pathname.includes("/download/");

  if (isTrelloDownloadUrl) {
    if (url.hostname === "trello.com") {
      url.hostname = "api.trello.com";
    }
    headers.set(
      "Authorization",
      `OAuth oauth_consumer_key="${key}", oauth_token="${token}"`,
    );
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Trello API error: ${response.status} ${body}`);
  }

  const blob = await response.blob();
  const contentLength = response.headers.get("content-length");
  const parsedSize = contentLength ? Number(contentLength) : undefined;
  return {
    blob,
    mimeType:
      response.headers.get("content-type") ||
      blob.type ||
      "application/octet-stream",
    size:
      typeof parsedSize === "number" && Number.isFinite(parsedSize)
        ? parsedSize
        : blob.size,
    url: url.toString(),
  };
}

export const trelloProvider = {
  async getBoard(boardId: string): Promise<TrelloBoard> {
    return await trelloFetch<TrelloBoard>(
      `/boards/${boardId}`,
      {},
      {
        fields: "id,name,url,shortUrl,closed",
      },
    );
  },

  async listMyBoards(): Promise<TrelloBoard[]> {
    return await trelloFetch<TrelloBoard[]>(
      `/members/me/boards`,
      {},
      {
        filter: "open",
        fields: "id,name,url,shortUrl,closed",
      },
    );
  },

  async getBoardLists(boardId: string): Promise<TrelloList[]> {
    return await trelloFetch<TrelloList[]>(`/boards/${boardId}/lists`, {}, {
      filter: "open",
    });
  },

  async createList(boardId: string, name: string): Promise<TrelloList> {
    return await trelloFetch<TrelloList>(
      "/lists",
      { method: "POST" },
      {
        idBoard: boardId,
        name,
        pos: "bottom",
      },
    );
  },

  async getBoardCustomFields(boardId: string): Promise<TrelloCustomField[]> {
    return await trelloFetch<TrelloCustomField[]>(`/boards/${boardId}/customFields`);
  },

  async getBoardMembers(boardId: string): Promise<TrelloMember[]> {
    return await trelloFetch<TrelloMember[]>(`/boards/${boardId}/members`, {}, {
      fields: "id,username,fullName,email,memberType,confirmed",
    });
  },

  async createCustomField(args: {
    boardId: string;
    name: string;
    type: "text" | "number" | "date" | "checkbox";
  }): Promise<TrelloCustomField> {
    return await trelloFetch<TrelloCustomField>(
      "/customFields",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idModel: args.boardId,
          modelType: "board",
          name: args.name,
          type: args.type,
          pos: "bottom",
          display_cardFront: true,
        }),
      },
    );
  },

  async createCard(args: {
    idList: string;
    name: string;
    desc?: string;
    due?: string;
    idLabels?: string[];
  }): Promise<TrelloCard> {
    return await trelloFetch<TrelloCard>(
      "/cards",
      { method: "POST" },
      {
        idList: args.idList,
        name: args.name,
        desc: args.desc,
        due: args.due,
        idLabels: args.idLabels?.join(","),
      },
    );
  },

  async updateCardList(args: {
    cardId: string;
    idList: string;
  }): Promise<TrelloCard> {
    return await trelloFetch<TrelloCard>(
      `/cards/${args.cardId}`,
      { method: "PUT" },
      {
        idList: args.idList,
      },
    );
  },

  async updateCardFields(args: {
    cardId: string;
    desc?: string;
    due?: string;
  }): Promise<TrelloCard> {
    return await trelloFetch<TrelloCard>(
      `/cards/${args.cardId}`,
      { method: "PUT" },
      {
        desc: args.desc,
        due: args.due,
      },
    );
  },

  async addCommentToCard(args: {
    cardId: string;
    text: string;
  }): Promise<TrelloComment> {
    return await trelloFetch<TrelloComment>(
      `/cards/${args.cardId}/actions/comments`,
      { method: "POST" },
      {
        text: args.text,
      },
    );
  },

  async addMemberToCard(args: {
    cardId: string;
    memberId: string;
  }): Promise<unknown> {
    return await trelloFetch(
      `/cards/${args.cardId}/idMembers`,
      { method: "POST" },
      {
        value: args.memberId,
      },
    );
  },

  async getBoardLabels(boardId: string): Promise<TrelloLabel[]> {
    return await trelloFetch<TrelloLabel[]>(`/boards/${boardId}/labels`, {}, {
      fields: "id,idBoard,name,color",
      limit: 1000,
    });
  },

  async createBoardLabel(args: {
    boardId: string;
    name: string;
    color: string;
  }): Promise<TrelloLabel> {
    return await trelloFetch<TrelloLabel>(
      "/labels",
      { method: "POST" },
      {
        idBoard: args.boardId,
        name: args.name,
        color: args.color,
      },
    );
  },

  async addCardAttachment(args: {
    cardId: string;
    name: string;
    file: Blob;
  }): Promise<TrelloAttachment> {
    const formData = new FormData();
    formData.append("file", args.file, args.name);
    formData.append("name", args.name);

    return await trelloFetch<TrelloAttachment>(
      `/cards/${args.cardId}/attachments`,
      {
        method: "POST",
        body: formData,
      },
      {
        setCover: false,
      },
    );
  },

  async downloadAttachment(args: {
    cardId: string;
    attachmentId: string;
    name?: string;
    url?: string;
  }): Promise<TrelloDownloadedAttachment> {
    const downloadUrl =
      args.url ||
      `/cards/${args.cardId}/attachments/${args.attachmentId}/download/${encodeURIComponent(
        args.name || args.attachmentId,
      )}`;
    const result = await trelloFetchBlob(downloadUrl);
    return {
      ...result,
      filename: args.name || args.attachmentId,
    };
  },

  async createWebhook(args: {
    callbackURL: string;
    idModel: string;
    description: string;
  }): Promise<TrelloWebhook> {
    return await trelloFetch<TrelloWebhook>(
      "/webhooks",
      { method: "POST" },
      {
        callbackURL: args.callbackURL,
        idModel: args.idModel,
        description: args.description,
      },
    );
  },

  async deleteWebhook(webhookId: string): Promise<unknown> {
    return await trelloFetch(
      `/webhooks/${webhookId}`,
      { method: "DELETE" },
    );
  },

  async setCustomFieldValue(args: {
    cardId: string;
    customFieldId: string;
    type: string;
    value: string | number | boolean;
  }): Promise<unknown> {
    let value: Record<string, string>;

    if (args.type === "number") {
      value = { number: String(args.value) };
    } else if (args.type === "checkbox") {
      value = { checked: args.value ? "true" : "false" };
    } else if (args.type === "date") {
      value = { date: String(args.value) };
    } else {
      value = { text: String(args.value) };
    }

    return await trelloFetch(
      `/cards/${args.cardId}/customField/${args.customFieldId}/item`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      },
    );
  },
};
