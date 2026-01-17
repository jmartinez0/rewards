import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";

const logWebhook = (...args) => {
  console.log("[refunds/create]", ...args);
};

const logWebhookError = (...args) => {
  console.error("[refunds/create]", ...args);
};

const parseMoneyToCents = (amount) => {
  if (amount == null) return 0;

  const normalized = String(amount).trim();
  if (!normalized) return 0;

  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [wholePart, fracPart = ""] = unsigned.split(".");
  const whole = Number(wholePart || "0");
  const frac = Number((fracPart + "00").slice(0, 2));
  const cents = whole * 100 + frac;

  return negative ? -cents : cents;
};

const getCustomerGid = (shopifyCustomerId) => {
  if (!shopifyCustomerId) return null;
  const raw = String(shopifyCustomerId);
  if (raw.startsWith("gid://shopify/Customer/")) return raw;
  const match = raw.match(/(\d+)$/);
  return match ? `gid://shopify/Customer/${match[1]}` : null;
};

const setCustomerCurrentPointsMetafield = async ({
  shopDomain,
  shopifyCustomerId,
  currentPoints,
}) => {
  const ownerId = getCustomerGid(shopifyCustomerId);
  if (!ownerId) return;

  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const mutation = `
      mutation SetCustomerPoints($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await admin.graphql(mutation, {
      variables: {
        metafields: [
          {
            ownerId,
            namespace: "rewards",
            key: "current_points",
            type: "number_integer",
            value: String(currentPoints),
          },
        ],
      },
    });

    const json = await response.json();
    const userErrors = json?.data?.metafieldsSet?.userErrors ?? [];
    if (userErrors.length > 0) {
      logWebhookError("Failed to set customer current_points metafield", {
        ownerId,
        userErrors,
      });
    }
  } catch (error) {
    logWebhookError("Error setting customer current_points metafield", {
      ownerId,
      error: error?.message ?? String(error),
    });
  }
};

const getRefundId = (refund) => {
  if (!refund) return null;
  if (refund?.admin_graphql_api_id) return refund.admin_graphql_api_id;
  if (refund?.id != null) return String(refund.id);
  return null;
};

const getOrderNumericId = (refund) => {
  const raw =
    refund?.order_id ??
    refund?.orderId ??
    refund?.order?.id ??
    refund?.order?.admin_graphql_api_id ??
    null;
  if (raw == null) return null;
  const match = String(raw).match(/(\d+)$/);
  return match ? match[1] : null;
};

const getRefundTotalCentsFromPayload = (refund) => {
  if (!refund) return null;

  const transactions = Array.isArray(refund.transactions) ? refund.transactions : [];
  const refundedTransactions = transactions.filter((transaction) => {
    const kind = String(transaction?.kind ?? "").toLowerCase();
    const status = String(transaction?.status ?? "").toLowerCase();
    return kind === "refund" && (!status || status === "success");
  });

  if (refundedTransactions.length) {
    const cents = refundedTransactions.reduce((sum, transaction) => {
      const amount =
        transaction?.amount_set?.shop_money?.amount ??
        transaction?.amount ??
        transaction?.amount_set?.presentment_money?.amount ??
        "0";
      return sum + parseMoneyToCents(amount);
    }, 0);
    if (cents > 0) return cents;
  }

  const refundLineItems = Array.isArray(refund.refund_line_items)
    ? refund.refund_line_items
    : Array.isArray(refund.refundLineItems)
      ? refund.refundLineItems
      : [];

  if (refundLineItems.length) {
    const cents = refundLineItems.reduce((sum, item) => {
      const amount =
        item?.subtotal_set?.shop_money?.amount ??
        item?.subtotal ??
        item?.subtotal_set?.presentment_money?.amount ??
        "0";
      return sum + parseMoneyToCents(amount);
    }, 0);
    if (cents > 0) return cents;
  }

  // Shipping-only refunds: fall back to shipping lines / adjustments when there are
  // no refund transactions and no refund line items.
  const refundShippingLines = Array.isArray(refund.refund_shipping_lines)
    ? refund.refund_shipping_lines
    : Array.isArray(refund.refundShippingLines)
      ? refund.refundShippingLines
      : [];

  const shippingCents = refundShippingLines.reduce((sum, line) => {
    const amount =
      line?.subtotal_set?.shop_money?.amount ??
      line?.discounted_price_set?.shop_money?.amount ??
      line?.price_set?.shop_money?.amount ??
      line?.subtotal ??
      line?.discounted_price ??
      line?.price ??
      "0";
    return sum + parseMoneyToCents(amount);
  }, 0);

  const orderAdjustments = Array.isArray(refund.order_adjustments)
    ? refund.order_adjustments
    : Array.isArray(refund.orderAdjustments)
      ? refund.orderAdjustments
      : [];

  const adjustmentCents = orderAdjustments.reduce((sum, adjustment) => {
    const amount =
      adjustment?.amount_set?.shop_money?.amount ??
      adjustment?.amount ??
      adjustment?.amount_set?.presentment_money?.amount ??
      "0";
    return sum + parseMoneyToCents(amount);
  }, 0);

  const fallbackCents = shippingCents + adjustmentCents;
  if (fallbackCents > 0) return fallbackCents;

  return null;
};

const fetchOrderSummary = async ({ shopDomain, orderNumericId }) => {
  if (!orderNumericId) return null;
  const { admin } = await unauthenticated.admin(shopDomain);

  const query = `
    query OrderSummary($id: ID!) {
      order(id: $id) {
        id
        email
        customer {
          id
          email
          firstName
          lastName
        }
        billingAddress {
          firstName
          lastName
        }
        shippingAddress {
          firstName
          lastName
        }
      }
    }
  `;

  const response = await admin.graphql(query, {
    variables: { id: `gid://shopify/Order/${orderNumericId}` },
  });
  const json = await response.json();
  return json?.data?.order ?? null;
};

const formatName = (firstName, lastName) => {
  const combined = [firstName, lastName].filter(Boolean).join(" ").trim();
  return combined ? combined.replace(/\s+/g, " ") : null;
};

const getOrderNameFromSummary = (order) => {
  const fromCustomer = formatName(order?.customer?.firstName, order?.customer?.lastName);
  if (fromCustomer) return fromCustomer;
  const fromBilling = formatName(order?.billingAddress?.firstName, order?.billingAddress?.lastName);
  if (fromBilling) return fromBilling;
  return formatName(order?.shippingAddress?.firstName, order?.shippingAddress?.lastName);
};

export const action = async ({ request }) => {
  const requestId = crypto?.randomUUID?.() ?? String(Date.now());
  const startedAt = Date.now();

  const { payload, session, topic, shop } = await authenticate.webhook(request);

  logWebhook("Received", { requestId, topic, shop, hasSession: Boolean(session) });

  if (!session) {
    logWebhook("skipping (no session)", { requestId });
    return new Response();
  }

  const refund = payload;
  const refundId = getRefundId(refund);
  const orderNumericId = getOrderNumericId(refund);
  const refundTotalCents = getRefundTotalCentsFromPayload(refund);

  logWebhook("Parsed payload", {
    requestId,
    refundId,
    orderNumericId,
    refundTotalCents,
  });

  const config = await db.config.findFirst({ orderBy: { id: "asc" } });
  if (!config?.isActive) {
    logWebhook("skipping (rewards inactive)", { requestId });
    return new Response();
  }

  if (!config?.pointsPerDollar) {
    logWebhook("skipping (pointsPerDollar not configured)", { requestId });
    return new Response();
  }

  if (refundTotalCents == null) {
    logWebhook("skipping (could not determine refund total)", { requestId, refundId });
    return new Response();
  }

  const order = await fetchOrderSummary({ shopDomain: shop, orderNumericId });
  const orderId = order?.id ?? (orderNumericId ? `gid://shopify/Order/${orderNumericId}` : null);
  const email = order?.email ?? order?.customer?.email ?? null;
  const shopifyCustomerId = order?.customer?.id ?? null;
  const name = getOrderNameFromSummary(order) ?? email;

  if (!orderId) {
    logWebhook("skipping (missing orderId)", { requestId, refundId });
    return new Response();
  }

  if (!email && !shopifyCustomerId) {
    logWebhook("skipping (missing email and customer id)", { requestId, orderId });
    return new Response();
  }

  let updatedCustomerForMetafield = null;

  try {
    updatedCustomerForMetafield = await db.$transaction(async (tx) => {
      const existingRefundAdjust =
        refundId
          ? await tx.ledgerEntry.findFirst({
              where: {
                type: "ADJUST",
                orderId,
                notes: `Refund from order ${orderId}`,
              },
            })
          : null;

      if (existingRefundAdjust) {
        logWebhook("skipping (refund already processed)", {
          requestId,
          existingRefundAdjustId: existingRefundAdjust.id,
        });

        const existingCustomer = shopifyCustomerId
          ? await tx.customer.findFirst({
              where: { shopifyCustomerId },
              select: { currentPoints: true, shopifyCustomerId: true },
            })
          : email
            ? await tx.customer.findUnique({
                where: { email },
                select: { currentPoints: true, shopifyCustomerId: true },
              })
            : null;

        if (existingCustomer?.shopifyCustomerId == null && shopifyCustomerId && email) {
          return await tx.customer.update({
            where: { email },
            data: { shopifyCustomerId },
            select: { currentPoints: true, shopifyCustomerId: true },
          });
        }

        return existingCustomer;
      }

      let customer = null;

      if (shopifyCustomerId) {
        customer = await tx.customer.findFirst({
          where: { shopifyCustomerId },
          select: {
            id: true,
            currentPoints: true,
            shopifyCustomerId: true,
          },
        });
      }

      if (!customer && email) {
        customer = await tx.customer.findUnique({
          where: { email },
          select: {
            id: true,
            currentPoints: true,
            shopifyCustomerId: true,
          },
        });
      }

      if (!customer) {
        logWebhook("creating customer (refund)", {
          requestId,
          email,
          hasShopifyCustomerId: Boolean(shopifyCustomerId),
          hasName: Boolean(name),
        });
        customer = await tx.customer.create({
          data: {
            email: email ?? `guest-${orderNumericId ?? "unknown"}@unknown`,
            name: name ?? "Guest",
            shopifyCustomerId,
          },
          select: {
            id: true,
            currentPoints: true,
            shopifyCustomerId: true,
          },
        });
      } else if (!customer.shopifyCustomerId && shopifyCustomerId) {
        customer = await tx.customer.update({
          where: { id: customer.id },
          data: { shopifyCustomerId },
          select: {
            id: true,
            currentPoints: true,
            shopifyCustomerId: true,
          },
        });
      } else if (shopifyCustomerId && customer.shopifyCustomerId !== shopifyCustomerId) {
        customer = await tx.customer.update({
          where: { id: customer.id },
          data: { shopifyCustomerId },
          select: {
            id: true,
            currentPoints: true,
            shopifyCustomerId: true,
          },
        });
      }

      const earnLot = await tx.ledgerEntry.findFirst({
        where: {
          type: "EARN",
          orderId,
          customerId: customer.id,
        },
        select: {
          id: true,
          remainingPoints: true,
          pointsPerDollar: true,
        },
      });

      const earnLotRemaining =
        earnLot && typeof earnLot.remainingPoints === "number"
          ? Math.max(0, earnLot.remainingPoints)
          : 0;

      const effectivePointsPerDollar =
        earnLot?.pointsPerDollar && earnLot.pointsPerDollar > 0
          ? earnLot.pointsPerDollar
          : config.pointsPerDollar;

      const pointsToRemove = Math.floor((refundTotalCents * effectivePointsPerDollar) / 100);
      // Refunds only deplete from the earn lot for this order.
      const removablePoints = Math.min(pointsToRemove, earnLotRemaining);

      if (pointsToRemove <= 0 || removablePoints <= 0) {
        logWebhook("skipping (no refundable points remaining in earn lot)", {
          requestId,
          refundTotalCents,
          effectivePointsPerDollar,
          pointsToRemove,
          earnLotRemaining,
          removablePoints,
        });
        return {
          currentPoints: customer.currentPoints,
          shopifyCustomerId: customer.shopifyCustomerId,
        };
      }

      logWebhook("Creating refund adjust ledger entry", {
        requestId,
        customerId: customer.id,
        orderId,
        refundId,
        pointsDelta: -removablePoints,
        pointsPerDollar: effectivePointsPerDollar,
      });

      await tx.ledgerEntry.update({
        where: { id: earnLot.id },
        data: { remainingPoints: Math.max(0, earnLotRemaining - removablePoints) },
      });

      await tx.ledgerEntry.create({
        data: {
          customerId: customer.id,
          type: "ADJUST",
          pointsDelta: -removablePoints,
          pointsPerDollar: effectivePointsPerDollar,
          notes: `Refund from order ${orderId}`,
          orderId,
          sourceLotId: earnLot?.id ?? null,
        },
      });

      const updatedCustomer = await tx.customer.update({
        where: { id: customer.id },
        data: {
          // Clamp to avoid negative balance if DB drift exists.
          currentPoints: { decrement: Math.min(removablePoints, customer.currentPoints) },
        },
        select: {
          currentPoints: true,
          shopifyCustomerId: true,
        },
      });

      return updatedCustomer;
    });
  } catch (error) {
    logWebhookError("transaction failed", {
      requestId,
      orderId,
      refundId,
      elapsedMs: Date.now() - startedAt,
      error: error?.message ?? String(error),
    });
    throw error;
  }

  logWebhook("Done", { requestId, elapsedMs: Date.now() - startedAt });

  if (updatedCustomerForMetafield) {
    await setCustomerCurrentPointsMetafield({
      shopDomain: shop,
      shopifyCustomerId: updatedCustomerForMetafield.shopifyCustomerId,
      currentPoints: updatedCustomerForMetafield.currentPoints,
    });
  }

  return new Response();
};
