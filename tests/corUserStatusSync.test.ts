import test from "node:test";
import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
import { syncInactiveCorUsersDaily } from "../convex/data/corUsersActions";
import { deactivateConfirmedMissingCorUsers } from "../convex/data/corUsers";

const localCorUsers = [
  { corUserDocumentId: "cor-user-1", corUserId: 101 },
  { corUserDocumentId: "cor-user-2", corUserId: 202 },
];

function createContext() {
  const mutations: Array<{ name: string; args: any }> = [];
  const ctx: any = {
    runQuery: async (ref: any) => {
      assert.equal(
        getFunctionName(ref),
        "data/corUsers:listActiveCorUsersForStatusSync",
      );
      return localCorUsers;
    },
    runMutation: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      mutations.push({ name, args });
      return {
        deactivatedCorUserIds: args.candidates.map(
          (candidate: any) => candidate.expectedCorUserId,
        ),
      };
    },
  };
  return { ctx, mutations };
}

async function withMockedCOR(
  t: test.TestContext,
  userResponses: Array<Response | Error>,
  run: () => Promise<void>,
) {
  const saved = {
    COR_API_KEY: process.env.COR_API_KEY,
    COR_CLIENT_SECRET: process.env.COR_CLIENT_SECRET,
  };
  process.env.COR_API_KEY = "test";
  process.env.COR_CLIENT_SECRET = "test";
  let userResponseIndex = 0;

  t.mock.method(globalThis, "fetch", async (input: any) => {
    const url = String(input);
    if (url.includes("/oauth/token")) {
      return Response.json({ access_token: "test-token" });
    }
    if (url.endsWith("/users?page=false")) {
      const response = userResponses[userResponseIndex++];
      if (response instanceof Error) throw response;
      if (!response) throw new Error("Unexpected extra COR users request");
      return response;
    }
    throw new Error(`Unexpected HTTP request: ${url}`);
  });

  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("does not write when every local COR user is still active", async (t) => {
  await withMockedCOR(
    t,
    [Response.json([{ id: 101 }, { id: 202 }, { id: 303 }])],
    async () => {
      const { ctx, mutations } = createContext();
      const result = await (syncInactiveCorUsersDaily as any)._handler(ctx, {});
      assert.deepEqual(result, { status: "unchanged", deactivated: 0 });
      assert.deepEqual(mutations, []);
    },
  );
});

test("deactivates only IDs absent from two identical successful snapshots", async (t) => {
  await withMockedCOR(
    t,
    [
      Response.json([{ id: 101 }, { id: 303 }]),
      Response.json([{ id: 303 }, { id: 101 }]),
    ],
    async () => {
      const { ctx, mutations } = createContext();
      const result = await (syncInactiveCorUsersDaily as any)._handler(ctx, {});
      assert.deepEqual(result, { status: "completed", deactivated: 1 });
      assert.equal(mutations.length, 1);
      assert.equal(
        mutations[0].name,
        "data/corUsers:deactivateConfirmedMissingCorUsers",
      );
      assert.deepEqual(mutations[0].args.candidates, [
        { corUserDocumentId: "cor-user-2", expectedCorUserId: 202 },
      ]);
    },
  );
});

test("does not write when COR fails or the two snapshots differ", async (t) => {
  await withMockedCOR(
    t,
    [
      Response.json([{ id: 101 }, { id: 303 }]),
      Response.json([{ id: 101 }, { id: 404 }]),
    ],
    async () => {
      const { ctx, mutations } = createContext();
      const result = await (syncInactiveCorUsersDaily as any)._handler(ctx, {});
      assert.deepEqual(result, {
        status: "unstable_snapshot",
        deactivated: 0,
      });
      assert.deepEqual(mutations, []);
    },
  );
});

test("does not write when COR returns an error or an empty list", async (t) => {
  for (const response of [
    new Response("unavailable", { status: 503 }),
    Response.json([]),
  ]) {
    await withMockedCOR(t, [response], async () => {
      const { ctx, mutations } = createContext();
      const result = await (syncInactiveCorUsersDaily as any)._handler(ctx, {});
      assert.deepEqual(result, { status: "error", deactivated: 0 });
      assert.deepEqual(mutations, []);
    });
  }
});

test("does not write when COR returns fewer users than active local links", async (t) => {
  await withMockedCOR(t, [Response.json([{ id: 101 }])], async () => {
    const { ctx, mutations } = createContext();
    const result = await (syncInactiveCorUsersDaily as any)._handler(ctx, {});
    assert.deepEqual(result, { status: "error", deactivated: 0 });
    assert.deepEqual(mutations, []);
  });
});

test("the final mutation patches only isActive and skips changed mappings", async () => {
  const patches: Array<{ id: string; value: unknown }> = [];
  const records: Record<string, any> = {
    current: { _id: "current", corUserId: 202, isActive: true },
    changed: { _id: "changed", corUserId: 999, isActive: true },
  };
  const ctx: any = {
    db: {
      get: async (id: string) => records[id] ?? null,
      patch: async (id: string, value: unknown) => patches.push({ id, value }),
    },
  };

  const result = await (deactivateConfirmedMissingCorUsers as any)._handler(
    ctx,
    {
      candidates: [
        { corUserDocumentId: "current", expectedCorUserId: 202 },
        { corUserDocumentId: "changed", expectedCorUserId: 303 },
      ],
    },
  );

  assert.deepEqual(patches, [{ id: "current", value: { isActive: false } }]);
  assert.deepEqual(result, { deactivatedCorUserIds: [202] });
});
