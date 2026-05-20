const TRELLO_API_BASE_URL = "https://api.trello.com/1";

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

  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Trello API error: ${response.status} ${body}`);
  }

  return (await response.json()) as T;
}

export const trelloProvider = {
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
