import { authenticate, unauthenticated } from "../shopify.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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
  const rawSessionToken = url.searchParams.get("sessionToken");

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
    const fakeRequest = new Request(request.url, {
      headers: {
        authorization: `Bearer ${rawSessionToken}`,
      },
    });

    const result = await authenticate.public.checkout(fakeRequest);
    sessionToken = result.sessionToken;
  } catch (error) {
    console.error(
      "Points earned API: authenticate.public.checkout (synthetic) failed:",
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
    const adminResponse = await adminClient.graphql(`
      query PointsData($orderId: ID!) {
        order(id: $orderId) {
          id
          currentTotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
        shop {
          metafield(namespace: "rewards", key: "points_per_dollar") {
            type
            value
          }
        }
      }
    `,
      {
        variables: { orderId: adminOrderId },
      },
    );

    const json = await adminResponse.json();
    const order = json?.data?.order;
    const metafield = json?.data?.shop?.metafield;

    if (!order || !metafield) {
      console.warn(
        "Points earned API: missing order or metafield: ",
        JSON.stringify(json),
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