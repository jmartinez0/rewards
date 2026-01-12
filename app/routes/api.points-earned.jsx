import db from "../db.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  const rawOrderId = url.searchParams.get("orderId");

  if (!rawOrderId) {
    return new Response(JSON.stringify({ error: "Missing orderId" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }

  let normalizedOrderId = rawOrderId;

  const idMatch = rawOrderId.match(/(\d+)$/);
  const numericId = idMatch ? idMatch[1] : null;

  if (numericId) {
    normalizedOrderId = `gid://shopify/Order/${numericId}`;
  }

  try {
    await db.$queryRaw`SELECT 1`;
  } catch (err) {
    console.error("DB warm failed:", err);
  }

  const entry = await db.rewardsLedgerEntry.findFirst({
    where: {
      orderId: normalizedOrderId,
      type: "EARN",
      pointsDelta: { gt: 0 },
    },
  });

  if (!entry) {
    console.log("POINTS API: no EARN entry yet for", normalizedOrderId);
  } else {
    console.log("POINTS API: found EARN entry", {
      orderId: normalizedOrderId,
      points: entry.pointsDelta,
    });
  }

  return new Response(
    JSON.stringify({ pointsEarned: entry?.pointsDelta ?? 0 }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    },
  );
};