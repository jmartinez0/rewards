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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...NOINDEX_HEADERS,
    },
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

const formatCentsToDollars = (cents) => {
  const amount = typeof cents === "number" && Number.isFinite(cents) ? cents : 0;
  return (amount / 100).toFixed(2);
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

    const { admin } = await unauthenticated.admin(shop);

    const mutation = `
      mutation CreateRewardsAmountDiscount(
        $basicCodeDiscount: DiscountCodeBasicInput!
      ) {
        discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
          codeDiscountNode {
            codeDiscount {
              ... on DiscountCodeBasic {
                codes(first: 1) {
                  nodes {
                    code
                  }
                }
              }
            }
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `;

    const uniqueCode = `REWARDS-${crypto
      .randomBytes(4)
      .toString("hex")
      .toUpperCase()}`;

    const basicCodeDiscount = {
      title: uniqueCode,
      code: uniqueCode,
      startsAt: new Date().toISOString(),
      usageLimit: 1,
      combinesWith: {
        orderDiscounts: false,
        productDiscounts: true,
        shippingDiscounts: false,
      },
      context: {
        customers: {
          add: [toCustomerGid(loggedInCustomerId)],
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
      variables: { basicCodeDiscount },
    });

    const gqlJson = await gqlRes.json();
    const payload = gqlJson?.data?.discountCodeBasicCreate;
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

    const createdCode =
      payload?.codeDiscountNode?.codeDiscount?.codes?.nodes?.[0]?.code ||
      uniqueCode;

    log("Created discount code", {
      shop,
      loggedInCustomerId,
      code: createdCode,
      rewardsCents,
      applyCents,
    });

    return jsonResponse({
      code: createdCode,
      rewardsSpent: applyCents,
    });
  } catch (err) {
    log("Unhandled error in action", err);
    return textResponse("Internal server error", 500);
  }
}
