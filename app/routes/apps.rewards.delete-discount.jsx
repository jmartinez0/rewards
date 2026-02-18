import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";

const log = (...args) => {
  console.log("[apps/rewards/delete-discount]", ...args);
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

    const shopifyCustomerId = loggedInCustomerId.startsWith("gid://")
      ? loggedInCustomerId
      : `gid://shopify/Customer/${loggedInCustomerId}`;

    const existing = await db.discount.findUnique({
      where: { shopifyCustomerId },
    });

    if (!existing) {
      return textResponse("OK", 200);
    }

    const { admin } = await unauthenticated.admin(shop);

    const deleteMutation = `
      mutation DiscountAutomaticDelete($id: ID!) {
        discountAutomaticDelete(id: $id) {
          deletedAutomaticDiscountId
          userErrors { field message }
        }
      }
    `;

    const deleteRes = await admin.graphql(deleteMutation, {
      variables: { id: existing.automaticDiscountNodeId },
    });
    const deleteJson = await deleteRes.json();
    const userErrors =
      deleteJson?.data?.discountAutomaticDelete?.userErrors ?? [];

    if (userErrors.length > 0) {
      log("Delete failed", {
        shop,
        loggedInCustomerId,
        userErrors,
      });
    }

    const resetMutation = `
      mutation ResetPendingRewards($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `;

    const resetRes = await admin.graphql(resetMutation, {
      variables: {
        metafields: [
          {
            ownerId: shopifyCustomerId,
            namespace: "rewards",
            key: "pending_rewards",
            type: "number_integer",
            value: "0",
          },
        ],
      },
    });
    const resetJson = await resetRes.json();
    const resetErrors = resetJson?.data?.metafieldsSet?.userErrors ?? [];
    if (resetErrors.length > 0) {
      log("Failed to reset pending rewards metafield", {
        shop,
        loggedInCustomerId,
        resetErrors,
      });
      return textResponse("Failed to reset pending rewards", 500);
    }

    await db.discount.delete({ where: { id: existing.id } });

    log("Deleted", { shop, loggedInCustomerId });
    return textResponse("OK", 200);
  } catch (err) {
    log("Unhandled error in action", err);
    return textResponse("Internal server error", 500);
  }
}
