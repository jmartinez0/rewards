import { authenticate, unauthenticated } from "../shopify.server";
import crypto from "node:crypto";
import db from "../db.server";

const log = (...args) => {
  console.log("[apps/rewards/create-discount]", ...args);
};

const NOINDEX_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow",
};

export async function loader() {
  return new Response("Not found", {
    status: 404,
    headers: NOINDEX_HEADERS,
  });
}

function textResponse(text, status) {
  return new Response(text, {
    status,
    headers: NOINDEX_HEADERS,
  });
}

function toCustomerGid(numericId) {
  const id = String(numericId);
  return `gid://shopify/Customer/${id}`;
}

const setCustomerPendingRewardsMetafield = async ({
  shopDomain,
  shopifyCustomerId,
  pendingRewardsCents,
}) => {
  if (!shopifyCustomerId) return false;
  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const mutation = `
      mutation SetPendingRewards($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `;

    const response = await admin.graphql(mutation, {
      variables: {
        metafields: [
          {
            ownerId: shopifyCustomerId,
            namespace: "rewards",
            key: "pending_rewards",
            type: "number_integer",
            value: String(pendingRewardsCents),
          },
        ],
      },
    });

    const json = await response.json();
    const userErrors = json?.data?.metafieldsSet?.userErrors ?? [];
    if (userErrors.length > 0) {
      log("Failed to set pending rewards metafield", {
        shopDomain,
        shopifyCustomerId,
        userErrors,
      });
      return false;
    }
    return true;
  } catch (err) {
    log("Error setting pending rewards metafield", {
      shopDomain,
      shopifyCustomerId,
      error: err?.message ?? String(err),
    });
    return false;
  }
};

const formatCentsToDollars = (cents) => {
  const amount = typeof cents === "number" && Number.isFinite(cents) ? cents : 0;
  return (amount / 100).toFixed(2);
};

const deleteAutomaticDiscountById = async ({ shopDomain, automaticDiscountNodeId }) => {
  if (!automaticDiscountNodeId) return;
  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const mutation = `
      mutation DiscountAutomaticDelete($id: ID!) {
        discountAutomaticDelete(id: $id) {
          deletedAutomaticDiscountId
          userErrors { field message }
        }
      }
    `;
    const res = await admin.graphql(mutation, { variables: { id: automaticDiscountNodeId } });
    const json = await res.json();
    const userErrors = json?.data?.discountAutomaticDelete?.userErrors ?? [];
    if (userErrors.length > 0) {
      log("Failed to delete existing automatic discount", {
        shopDomain,
        automaticDiscountNodeId,
        userErrors,
      });
    }
  } catch (err) {
    log("Error deleting existing automatic discount", {
      shopDomain,
      automaticDiscountNodeId,
      error: err?.message ?? String(err),
    });
  }
};

export async function action({ request }) {
  try {
    await authenticate.public.appProxy(request);

    const url = new URL(request.url);
    const shop = url.searchParams.get("shop");
    const loggedInCustomerId = url.searchParams.get("logged_in_customer_id");

    if (!shop) {
      return textResponse("Missing shop", 400);
    }

    if (!loggedInCustomerId) {
      return textResponse("Customer not logged in", 401);
    }

    log("Request", { shop, loggedInCustomerId });

    let rewardsCents;
    let cartTotalCents;

    try {
      const body = await request.json();
      rewardsCents =
        typeof body?.rewardsCents === "number"
          ? body.rewardsCents
          : body?.rewardsCents != null
            ? Number(body.rewardsCents)
            : null;

      cartTotalCents =
        typeof body?.cartTotalCents === "number"
          ? body.cartTotalCents
          : body?.cartTotalCents != null
            ? Number(body.cartTotalCents)
            : null;
    } catch {
      return textResponse("Invalid JSON body", 400);
    }

    if (
      typeof rewardsCents !== "number" ||
      !Number.isFinite(rewardsCents) ||
      !Number.isInteger(rewardsCents) ||
      rewardsCents <= 0
    ) {
      return textResponse("Invalid rewards amount", 400);
    }

    if (
      typeof cartTotalCents !== "number" ||
      !Number.isFinite(cartTotalCents) ||
      !Number.isInteger(cartTotalCents) ||
      cartTotalCents <= 0
    ) {
      return textResponse("Invalid cart total", 400);
    }

    const shopifyCustomerId = toCustomerGid(loggedInCustomerId);

    const customer = await db.customer.findFirst({
      where: { shopifyCustomerId },
      select: {
        id: true,
        currentRewardsCents: true,
      },
    });

    if (!customer) {
      return textResponse("Customer not found", 404);
    }

    if (customer.currentRewardsCents < rewardsCents) {
      return textResponse(
        `Not enough rewards (${customer.currentRewardsCents} < ${rewardsCents})`,
        403,
      );
    }

    const applyCents = Math.min(rewardsCents, cartTotalCents);
    if (applyCents <= 0) {
      return textResponse("Invalid rewards amount", 400);
    }

    const existing = await db.discount.findUnique({
      where: { shopifyCustomerId },
      select: { id: true, automaticDiscountNodeId: true },
    });

    if (existing?.automaticDiscountNodeId) {
      await deleteAutomaticDiscountById({
        shopDomain: shop,
        automaticDiscountNodeId: existing.automaticDiscountNodeId,
      });
      await db.discount.delete({ where: { id: existing.id } });
    }

    const { admin } = await unauthenticated.admin(shop);

    const mutation = `
      mutation CreateRewardsAutomaticDiscount(
        $automaticBasicDiscount: DiscountAutomaticBasicInput!
      ) {
        discountAutomaticBasicCreate(automaticBasicDiscount: $automaticBasicDiscount) {
          automaticDiscountNode {
            id
            automaticDiscount {
              __typename
              ... on DiscountAutomaticBasic {
                title
                startsAt
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const uniqueTitle = `REWARDS-${crypto
      .randomBytes(4)
      .toString("hex")
      .toUpperCase()}`;

    const automaticBasicDiscount = {
      title: uniqueTitle,
      startsAt: new Date().toISOString(),
      combinesWith: {
        orderDiscounts: false,
        productDiscounts: true,
        shippingDiscounts: false,
      },
      context: {
        customers: {
          add: [shopifyCustomerId],
        },
      },
      customerGets: {
        value: {
          discountAmount: {
            amount: formatCentsToDollars(applyCents),
            appliesOnEachItem: false,
          },
        },
        items: { all: true },
      },
    };

    const gqlRes = await admin.graphql(mutation, {
      variables: { automaticBasicDiscount },
    });

    const gqlJson = await gqlRes.json();
    const payload = gqlJson?.data?.discountAutomaticBasicCreate;
    const userErrors = payload?.userErrors ?? [];

    if (!payload || userErrors.length > 0) {
      log("Failed to create discount", {
        shop,
        loggedInCustomerId,
        userErrors,
        errors: gqlJson?.errors,
      });
      return textResponse("Failed to create discount", 500);
    }

    const automaticNodeId = payload?.automaticDiscountNode?.id ?? null;

    if (!automaticNodeId) {
      log("Automatic discount missing node id", {
        shop,
        loggedInCustomerId,
        payload,
      });
      return textResponse("Failed to create discount", 500);
    }

    const pendingRewardsSet = await setCustomerPendingRewardsMetafield({
      shopDomain: shop,
      shopifyCustomerId,
      pendingRewardsCents: applyCents,
    });
    if (!pendingRewardsSet) {
      await deleteAutomaticDiscountById({
        shopDomain: shop,
        automaticDiscountNodeId: automaticNodeId,
      });
      return textResponse("Failed to set pending rewards", 500);
    }

    await db.discount.create({
      data: {
        shopifyCustomerId,
        automaticDiscountNodeId: automaticNodeId,
        discountTitle: uniqueTitle,
      },
    });

    log("Created discount", {
      shop,
      loggedInCustomerId,
      title: uniqueTitle,
      rewardsCents,
      applyCents,
    });

    return textResponse("OK", 200);
  } catch (err) {
    log("Unhandled error in action", err);
    return textResponse("Internal server error", 500);
  }
}
