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

export async function action({ request }) {
  try {
    log("Action start");

    await authenticate.public.appProxy(request);
    log("After appProxy auth");

    const url = new URL(request.url);
    const shop = url.searchParams.get("shop");
    const loggedInCustomerId = url.searchParams.get("logged_in_customer_id");

    if (!shop) {
      log("Missing shop");
      return new Response("Missing shop", { status: 400 });
    }

    if (!loggedInCustomerId) {
      log("Customer not logged in");
      return new Response("Customer not logged in", { status: 401 });
    }

    log("Request", { shop, loggedInCustomerId });

    let points;
    try {
      const body = await request.json();
      points = Number(body.points);
    } catch (error) {
      log("Invalid JSON body", error);
      return new Response("Invalid JSON body", { status: 400 });
    }

    if (!points || points <= 0 || !Number.isFinite(points)) {
      log("Invalid points value", { points });
      return new Response("Invalid points", { status: 400 });
    }

    const shopifyCustomerId = toCustomerGid(loggedInCustomerId);

    const rewardsCustomer = await db.customer.findFirst({
      where: {
        shopifyCustomerId,
      },
      select: {
        currentPoints: true,
      },
    });

    if (!rewardsCustomer) {
      log("Rewards customer not found", { shopifyCustomerId });
      return new Response("Rewards customer not found", { status: 404 });
    }

    if (rewardsCustomer.currentPoints < points) {
      log("Not enough points", {
        currentPoints: rewardsCustomer.currentPoints,
        requestedPoints: points,
      });
      return new Response(
        `Not enough points (${rewardsCustomer.currentPoints} < ${points})`,
        { status: 403 },
      );
    }

    const rule = await db.discountRule.findFirst({
      where: {
        points,
        isActive: true,
      },
      select: {
        percentOff: true,
      },
    });

    if (!rule) {
      log("No matching active discount rule", { points });
      return new Response("No matching active discount rule", { status: 400 });
    }

    const percent = Number(rule.percentOff);
    const fraction = percent / 100;

    const { admin } = await unauthenticated.admin(shop);
    log("Got admin client");

    const mutation = `
      mutation CreatePointsPercentDiscount(
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

    const baseCode = `${points}PTS-${percent}OFF`;
    const uniqueCode = `${baseCode}-${crypto
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
          percentage: fraction,
        },
        items: {
          all: true,
        },
      },
    };

    log("About to call Admin GraphQL", {
      shop,
      mutationName: "CreatePointsPercentDiscount",
      basicCodeDiscount,
    });

    let gqlRes;
    try {
      gqlRes = await admin.graphql(mutation, {
        variables: { basicCodeDiscount },
      });
    } catch (error) {
      log("GraphQL network error (admin.graphql threw)", error);
      return new Response("Failed to create discount (network/graphql error)", {
        status: 500,
      });
    }

    log("GraphQL HTTP response status", {
      ok: gqlRes.ok,
      status: gqlRes.status,
      statusText: gqlRes.statusText,
    });

    let gqlText;
    try {
      gqlText = await gqlRes.text();
    } catch (error) {
      log("Failed to read GraphQL response text", error);
      return new Response("Failed to create discount (read error)", {
        status: 500,
      });
    }

    log("GraphQL raw response text", gqlText);

    let gqlJson;
    try {
      gqlJson = JSON.parse(gqlText);
    } catch (error) {
      log("Failed to parse GraphQL JSON", error);
      return new Response("Failed to create discount (invalid JSON)", {
        status: 500,
      });
    }

    if (gqlJson.errors && gqlJson.errors.length > 0) {
      log("GraphQL top-level errors", gqlJson.errors);
      return new Response("Failed to create discount (GraphQL error)", {
        status: 500,
      });
    }

    const payload = gqlJson?.data?.discountCodeBasicCreate;
    if (!payload) {
      log("No payload in discountCodeBasicCreate response", gqlJson);
      return new Response("Failed to create discount (no payload)", {
        status: 500,
      });
    }

    const userErrors = payload.userErrors ?? [];
    if (userErrors.length > 0) {
      log("Discount userErrors", userErrors);
      return new Response("Failed to create discount", { status: 500 });
    }

    const createdCode =
      payload?.codeDiscountNode?.codeDiscount?.codes?.nodes?.[0]?.code ||
      uniqueCode;

    log("Created discount code", {
      shop,
      loggedInCustomerId,
      code: createdCode,
      percent,
    });

    return new Response(
      JSON.stringify({
        code: createdCode,
        percent,
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