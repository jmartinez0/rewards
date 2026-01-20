import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const log = (...args) => {
  console.log("[rewards-earned]", ...args);
};

const parseMoneyToCents = (amount) => {
  const normalized = String(amount ?? "").trim();
  if (!normalized) return 0;
  const [wholePart, fracPart = ""] = normalized.split(".");
  const whole = Number(wholePart || "0");
  const frac = Number((fracPart + "00").slice(0, 2));
  return whole * 100 + frac;
};

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  const url = new URL(request.url);
  const rawOrderId = url.searchParams.get("orderId");
  const authHeader = request.headers.get("authorization");
  const rawSessionToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;

  log("Request", {
    method: request.method,
    url: request.url,
    origin: request.headers.get("origin"),
    referer: request.headers.get("referer"),
    hasAuthorization: Boolean(authHeader),
    orderId: rawOrderId,
  });

  if (!rawOrderId) {
    return new Response(JSON.stringify({ error: "Missing orderId" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  if (!rawSessionToken) {
    return new Response(JSON.stringify({ error: "Missing sessionToken" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  let sessionToken;
  try {
    const result = await authenticate.public.checkout(request);
    sessionToken = result.sessionToken;
  } catch (err) {
    log("Unauthorized", { error: err?.message ?? String(err) });
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const shopDomain = sessionToken.dest;

  const config = await db.config.findUnique({ where: { id: 1 } });
  if (!config?.isActive || !config?.centsToOneUsd) {
    return new Response(JSON.stringify({ rewardsEarnedCents: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const { admin } = await unauthenticated.admin(shopDomain);

  const idMatch = rawOrderId.match(/(\d+)$/);
  const numericId = idMatch ? idMatch[1] : null;
  const adminOrderId = numericId ? `gid://shopify/Order/${numericId}` : rawOrderId;

  const configQuery = `
    query RewardsConfig {
      shop {
        metafield(namespace: "rewards", key: "cents_to_one_usd") {
          type
          value
        }
      }
    }
  `;

  const orderQuery = `
    query OrderTotal($orderId: ID!) {
      order(id: $orderId) {
        id
        currentTotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
    }
  `;

  try {
    const [configResponse, orderResponse] = await Promise.all([
      admin.graphql(configQuery),
      admin.graphql(orderQuery, { variables: { orderId: adminOrderId } }),
    ]);

    const [configJson, orderJson] = await Promise.all([
      configResponse.json(),
      orderResponse.json(),
    ]);

    const order = orderJson?.data?.order;
    const metafield = configJson?.data?.shop?.metafield;
    const centsToOneUsd = Number(metafield?.value ?? 0);

    if (!order || !Number.isFinite(centsToOneUsd) || centsToOneUsd <= 0) {
      return new Response(JSON.stringify({ rewardsEarnedCents: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    const totalAmount = order.currentTotalPriceSet?.shopMoney?.amount ?? null;
    if (totalAmount == null) {
      return new Response(JSON.stringify({ rewardsEarnedCents: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    const orderTotalCents = parseMoneyToCents(totalAmount);
    const rewardsEarnedCents = Math.floor((orderTotalCents * 100) / centsToOneUsd);

    return new Response(JSON.stringify({ rewardsEarnedCents }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (err) {
    log("Error", { error: err?.message ?? String(err) });
    return new Response(JSON.stringify({ rewardsEarnedCents: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
};
