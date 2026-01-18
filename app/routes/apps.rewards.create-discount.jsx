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

  log("Request", { shop, loggedInCustomerId, });

  let points;
  try {
    const body = await request.json();
    points = Number(body.points);
  } catch (error) {
    return new Response("Invalid JSON body", { status: 400 });
  }

  if (!points || points <= 0 || !Number.isFinite(points)) {
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
    return new Response("Rewards customer not found", { status: 404 });
  }

  if (rewardsCustomer.currentPoints < points) {
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
    return new Response("No matching active discount rule", { status: 400 });
  }

  const percent = Number(rule.percentOff);
  const fraction = percent / 100;

  const { admin } = await unauthenticated.admin(shop);

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
        }
      }
    }
  `;

  const baseCode = `${points}PTS-${percent}OFF`;
  const uniqueCode = `${baseCode}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

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

  const gqlRes = await admin.graphql(mutation, {
    variables: { basicCodeDiscount },
  });
  const gqlJson = await gqlRes.json();

  const payload = gqlJson?.data?.discountCodeBasicCreate;
  const errors = payload?.userErrors ?? [];

  if (errors.length > 0) {
    return new Response("Failed to create discount", { status: 500 });
  }

  const createdCode =
    payload?.codeDiscountNode?.codeDiscount?.codes?.nodes?.[0]?.code ||
    uniqueCode;

  log("Created", { shop, loggedInCustomerId, code: createdCode });

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
}
