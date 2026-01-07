import { authenticate } from "../shopify.server";
import db from "../db.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  const { cors } = await authenticate.public.checkout(request);

  const orderId = url.searchParams.get("orderId");

  if (!orderId) {
    return cors(
      new Response(JSON.stringify({ error: "Missing orderId" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  const entry = await db.rewardsLedgerEntry.findFirst({
    where: {
      orderId,
      type: "EARN",
      creationMethod: "AUTO",
      pointsDelta: { gt: 0 },
    },
  });

  return cors(
    new Response(
      JSON.stringify({ pointsEarned: entry?.pointsDelta ?? 0 }),
      { headers: { "Content-Type": "application/json" } },
    ),
  );
};