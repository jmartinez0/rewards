import { authenticate, unauthenticated } from "../shopify.server";

const log = (...args) => {
  console.log("[apps/rewards/current-rewards]", ...args);
};

export async function loader({ request }) {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const customerIdFromExtension = url.searchParams.get("customer_id");
  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id");

  if (!shop) {
    return new Response(JSON.stringify({ error: "Missing shop" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const effectiveCustomerId = customerIdFromExtension || loggedInCustomerId;
  if (!effectiveCustomerId) {
    log("Customer not provided", { shop });
    return new Response(JSON.stringify({ error: "Customer not provided" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const customerGid = effectiveCustomerId.startsWith("gid://")
    ? effectiveCustomerId
    : `gid://shopify/Customer/${effectiveCustomerId}`;

  const { admin } = await unauthenticated.admin(shop);

  const query = `
    query GetCustomerRewards($id: ID!) {
      customer(id: $id) {
        current: metafield(namespace: "rewards", key: "current_rewards") { value }
        lifetime: metafield(namespace: "rewards", key: "lifetime_rewards") { value }
      }
    }
  `;

  try {
    const response = await admin.graphql(query, {
      variables: { id: customerGid },
    });
    const json = await response.json();

    const customer = json?.data?.customer;
    const currentRewardsCents =
      customer?.current?.value != null ? Number(customer.current.value) : 0;
    const lifetimeRewardsCents =
      customer?.lifetime?.value != null ? Number(customer.lifetime.value) : 0;

    log("Response", { shop, customerGid, currentRewardsCents, lifetimeRewardsCents });

    return new Response(
      JSON.stringify({ currentRewardsCents, lifetimeRewardsCents }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    log("Error", { shop, customerGid, error: err?.message ?? String(err) });
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

