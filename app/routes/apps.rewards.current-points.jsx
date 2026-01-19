import { authenticate, unauthenticated } from "../shopify.server";

const log = (...args) => {
  console.log("[apps/rewards/current-points]", ...args);
};

const ALLOWED_ORIGINS = ["https://extensions.shopifycdn.com"];

function buildCorsHeaders(request, extraHeaders = {}) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Credentials": "true",
    ...extraHeaders,
  };

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  } else {
  }

  return headers;
}

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    const headers = buildCorsHeaders(request, {
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept",
    });

    return new Response(null, {
      status: 204,
      headers,
    });
  }

  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const customerIdFromExtension = url.searchParams.get("customer_id");
  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id");

  if (!shop) {
    return new Response(JSON.stringify({ error: "Missing shop" }), {
      status: 400,
      headers: buildCorsHeaders(request),
    });
  }

  const effectiveCustomerId = customerIdFromExtension || loggedInCustomerId;

  if (!effectiveCustomerId) {
    log("Customer not provided", { shop });
    return new Response(JSON.stringify({ error: "Customer not provided" }), {
      status: 401,
      headers: buildCorsHeaders(request),
    });
  }

  const customerGid =
    effectiveCustomerId.startsWith("gid://")
      ? effectiveCustomerId
      : `gid://shopify/Customer/${effectiveCustomerId}`;

  log("Request", { shop, customerGid });

  const { admin } = await unauthenticated.admin(shop);

  const query = `
    query GetCustomerRewardsPoints($id: ID!) {
      customer(id: $id) {
        metafield(namespace: "rewards", key: "current_points") {
          value
        }
      }
    }
  `;

  try {
    const response = await admin.graphql(query, {
      variables: { id: customerGid },
    });
    const json = await response.json();

    const customer = json?.data?.customer;
    const metafield = customer?.metafield;
    const currentPoints =
      metafield && metafield.value != null ? Number(metafield.value) : null;

    log("Response", { shop, customerGid, currentPoints });

    return new Response(JSON.stringify({ currentPoints }), {
      status: 200,
      headers: buildCorsHeaders(request),
    });
  } catch (error) {
    console.error("[apps/rewards/current-points] Error", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: buildCorsHeaders(request),
    });
  }
}