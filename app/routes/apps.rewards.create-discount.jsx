import { authenticate, unauthenticated } from "../shopify.server";
import crypto from "node:crypto";
import db from "../db.server";

const log = (...args) => {
  console.log("[apps/rewards/create-discount]", ...args);
};

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
      return new Response("Missing shop", { status: 400 });
    }

    if (!loggedInCustomerId) {
      return new Response("Customer not logged in", { status: 401 });
    }

    log("Request", { shop, loggedInCustomerId });

    let rewardsCents;
    try {
      const body = await request.json();
      rewardsCents =
        typeof body?.rewardsCents === "number"
          ? body.rewardsCents
          : body?.rewardsCents != null
            ? Number(body.rewardsCents)
            : null;
    } catch (error) {
      return new Response("Invalid JSON body", { status: 400 });
    }

    if (
      typeof rewardsCents !== "number" ||
      !Number.isFinite(rewardsCents) ||
      !Number.isInteger(rewardsCents) ||
      rewardsCents <= 0
    ) {
      return new Response("Invalid rewards amount", { status: 400 });
    }

    const shopifyCustomerId = toCustomerGid(loggedInCustomerId);

    const customer = await db.customer.findFirst({
      where: {
        shopifyCustomerId,
      },
      select: {
        id: true,
        currentRewardsCents: true,
      },
    });

    if (!customer) {
      return new Response("Customer not found", { status: 404 });
    }

    if (customer.currentRewardsCents < rewardsCents) {
      return new Response(
        `Not enough rewards (${customer.currentRewardsCents} < ${rewardsCents})`,
        { status: 403 },
      );
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

    const uniqueCode = `REWARDS-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

    const basicCodeDiscount = {
      title: uniqueCode,
      code: uniqueCode,
      startsAt: new Date().toISOString(),
      usageLimit: 1,
      combinesWith: {
        orderDiscounts: false,
        productDiscounts: false,
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
            amount: formatCentsToDollars(rewardsCents),
            appliesOnEachItem: false,
          },
        },
        items: {
          all: true,
        },
      },
    };

    const gqlRes = await admin.graphql(mutation, {
      variables: { basicCodeDiscount },
    });
    const gqlJson = await gqlRes.json();

    const payload = gqlJson?.data?.discountCodeBasicCreate;
    const userErrors = payload?.userErrors ?? [];
    if (!payload || userErrors.length > 0) {
      log("Failed to create discount", { shop, loggedInCustomerId, userErrors, errors: gqlJson?.errors });
      return new Response("Failed to create discount", { status: 500 });
    }

    const createdCode =
      payload?.codeDiscountNode?.codeDiscount?.codes?.nodes?.[0]?.code ||
      uniqueCode;

    log("Created discount code", {
      shop,
      loggedInCustomerId,
      code: createdCode,
      rewardsCents,
    });

    return new Response(
      JSON.stringify({
        code: createdCode,
        amount: formatCentsToDollars(rewardsCents),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    log("Unhandled error in action", err);
    return new Response("Internal server error", { status: 500 });
  }
}
