import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const logPointsApi = (...args) => {
  console.log("[points-earned]", ...args);
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

  logPointsApi("request", {
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
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }

  if (!rawSessionToken) {
    return new Response(JSON.stringify({ error: "Missing sessionToken" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }

  let sessionToken;
  try {
    const result = await authenticate.public.checkout(request);
    sessionToken = result.sessionToken;
  } catch (error) {
    console.error(
      "Points earned API: authenticate.public.checkout failed:",
      error,
    );
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }

  const shopDomain = sessionToken.dest;

  const config = await db.config.findFirst({ orderBy: { id: "asc" } });
  if (!config?.isActive || !config?.configuredPointsPerDollar) {
    logPointsApi("Skipping (rewards disabled)", { shopDomain });
    return new Response(JSON.stringify({ pointsEarned: 0 }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }

  let adminClient;

  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    adminClient = admin;
  } catch (error) {
    console.error(
      "Points earned API: unauthenticated.admin failed for shop",
      shopDomain,
      error,
    );
    return new Response(JSON.stringify({ error: "Admin client error" }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }

  const idMatch = rawOrderId.match(/(\d+)$/);
  const numericId = idMatch ? idMatch[1] : null;
  const adminOrderId = numericId
    ? `gid://shopify/Order/${numericId}`
    : rawOrderId;

  try {
    const configQuery = `
      query RewardsConfig {
        shop {
          metafield(namespace: "rewards", key: "points_per_dollar") {
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

    const [configResponse, orderResponse] = await Promise.all([
      adminClient.graphql(configQuery),
      adminClient.graphql(orderQuery, { variables: { orderId: adminOrderId } }),
    ]);

    const [configJson, orderJson] = await Promise.all([
      configResponse.json(),
      orderResponse.json(),
    ]);

    logPointsApi("graphql:configResult", {
      data: configJson?.data,
      errors: configJson?.errors,
    });
    logPointsApi("graphql:orderResult", {
      data: orderJson?.data,
      errors: orderJson?.errors,
    });

    const order = orderJson?.data?.order;
    const metafield = configJson?.data?.shop?.metafield;

    if (!order || !metafield) {
      console.warn(
        "Points earned API: missing order or metafield: ",
        JSON.stringify({ config: configJson, order: orderJson }),
      );
      return new Response(JSON.stringify({ pointsEarned: 0 }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
        },
      });
    }

    const totalAmount = order.currentTotalPriceSet?.shopMoney?.amount ?? null;
    const pointsPerDollar = Number(metafield.value ?? 0);

    if (
      totalAmount == null ||
      !Number.isFinite(pointsPerDollar) ||
      pointsPerDollar <= 0
    ) {
      return new Response(JSON.stringify({ pointsEarned: 0 }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
        },
      });
    }

    const orderTotalCents = parseMoneyToCents(totalAmount);
    const points = Math.floor((orderTotalCents * pointsPerDollar) / 100);

    logPointsApi("math", {
      orderId: adminOrderId,
      totalAmount,
      orderTotalCents,
      pointsPerDollar,
      points,
    });

    return new Response(JSON.stringify({ pointsEarned: points }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  } catch (error) {
    console.error("Points earned API: error computing points: ", error);
    return new Response(JSON.stringify({ pointsEarned: 0 }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }
};
