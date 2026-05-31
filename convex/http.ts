import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

function base64FromArrayBuffer(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function verifyTrelloWebhookSignature(args: {
  bodyText: string;
  callbackURL: string;
  signature: string | null;
}) {
  const secret = process.env.TRELLO_APP_SECRET;
  if (!secret) {
    throw new Error("Falta TRELLO_APP_SECRET en Convex.");
  }
  if (!args.signature) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(args.bodyText + args.callbackURL),
  );
  const expected = base64FromArrayBuffer(digest);
  return constantTimeEqual(expected, args.signature);
}

http.route({
  path: "/trello/webhook",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(null, { status: 200 });
  }),
});

http.route({
  path: "/trello/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const bodyText = await request.text();
    const callbackURL = process.env.TRELLO_WEBHOOK_CALLBACK_URL || request.url;

    try {
      const isValid = await verifyTrelloWebhookSignature({
        bodyText,
        callbackURL,
        signature: request.headers.get("x-trello-webhook"),
      });

      if (!isValid) {
        return new Response("Invalid Trello webhook signature", { status: 401 });
      }

      const payload = JSON.parse(bodyText);
      const action = payload?.action;
      const actionId = action?.id;
      const actionType = action?.type;

      if (!actionId || !actionType) {
        return new Response("Invalid Trello webhook payload", { status: 400 });
      }

      await ctx.runMutation(internal.data.trello.recordWebhookEvent, {
        trelloActionId: actionId,
        trelloWebhookId: payload?.webhook?.id,
        trelloBoardId:
          action?.data?.board?.id ||
          payload?.model?.id ||
          payload?.webhook?.idModel,
        trelloCardId: action?.data?.card?.id,
        actionType,
        sourceIdentifier: request.headers.get("x-trello-client-identifier") || undefined,
        payloadJson: bodyText,
      });

      return new Response("OK", { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[TrelloWebhook] Error: ${message}`);
      return new Response("Trello webhook error", { status: 500 });
    }
  }),
});

export default http;
