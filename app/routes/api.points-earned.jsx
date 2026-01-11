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

  const orderId = url.searchParams.get("orderId");

  if (!orderId) {
    return new Response(JSON.stringify({ error: "Missing orderId" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }

  try {
    await db.$queryRaw`SELECT 1`;
  } catch (err) {
    console.error("DB warm failed:", err);
  }
  
  const entry = await db.rewardsLedgerEntry.findFirst({
    where: {
      orderId,
      type: "EARN",
      pointsDelta: { gt: 0 },
    },
  });

  return new Response(
    JSON.stringify({ pointsEarned: entry?.pointsDelta ?? 0 }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    }
  );
};
