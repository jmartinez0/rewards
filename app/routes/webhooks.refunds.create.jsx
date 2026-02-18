import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";

const log = (...args) => console.log("[refunds/create]", ...args);
const error = (...args) => console.error("[refunds/create]", ...args);

const parseMoneyToCents = (amount) => {
  const normalized = String(amount ?? "").trim();
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

const setCustomerRewardsMetafields = async ({
  shopDomain,
  shopifyCustomerId,
  currentRewardsCents,
  lifetimeRewardsCents,
}) => {
  const ownerId = getCustomerGid(shopifyCustomerId);
  if (!ownerId) return;

  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const mutation = `
      mutation SetCustomerRewards($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `;

    const response = await admin.graphql(mutation, {
      variables: {
        metafields: [
          {
            ownerId,
            namespace: "rewards",
            key: "current_rewards",
            type: "number_integer",
            value: String(currentRewardsCents),
          },
          {
            ownerId,
            namespace: "rewards",
            key: "lifetime_rewards",
            type: "number_integer",
            value: String(lifetimeRewardsCents),
          },
        ],
      },
    });

    const json = await response.json();
    const userErrors = json?.data?.metafieldsSet?.userErrors ?? [];
    if (userErrors.length > 0) {
      error("Failed to set customer rewards metafields", { ownerId, userErrors });
    }
  } catch (err) {
    error("Error setting customer rewards metafields", {
      ownerId,
      error: err?.message ?? String(err),
    });
  }
};

const getRefundId = (refund) =>
  refund?.admin_graphql_api_id ? refund.admin_graphql_api_id : refund?.id != null ? String(refund.id) : null;

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
  const transactions = Array.isArray(refund?.transactions) ? refund.transactions : [];
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

  const refundLineItems = Array.isArray(refund?.refund_line_items)
    ? refund.refund_line_items
    : Array.isArray(refund?.refundLineItems)
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

  const refundShippingLines = Array.isArray(refund?.refund_shipping_lines)
    ? refund.refund_shipping_lines
    : Array.isArray(refund?.refundShippingLines)
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

  const orderAdjustments = Array.isArray(refund?.order_adjustments)
    ? refund.order_adjustments
    : Array.isArray(refund?.orderAdjustments)
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
        originalTotalPriceSet { shopMoney { amount } }
        totalPriceSet { shopMoney { amount } }
        currentTotalPriceSet { shopMoney { amount } }
        customer { id email }
      }
    }
  `;

  const response = await admin.graphql(query, {
    variables: { id: `gid://shopify/Order/${orderNumericId}` },
  });
  const json = await response.json();
  return json?.data?.order ?? null;
};

const computeEarnedRewardsCents = ({ totalCents, centsToOneUsd }) => {
  if (!Number.isFinite(totalCents) || totalCents <= 0) return 0;
  if (!Number.isFinite(centsToOneUsd) || centsToOneUsd <= 0) return 0;
  return Math.floor((totalCents * 100) / centsToOneUsd);
};

const getOrderTotalCentsForRefundMath = (order) => {
  const candidates = [
    order?.originalTotalPriceSet?.shopMoney?.amount,
    order?.totalPriceSet?.shopMoney?.amount,
    order?.currentTotalPriceSet?.shopMoney?.amount,
  ]
    .map((amount) => parseMoneyToCents(amount))
    .filter((cents) => Number.isFinite(cents) && cents > 0);

  if (!candidates.length) return 0;
  return Math.max(...candidates);
};

export const action = async ({ request }) => {
  const requestId = crypto?.randomUUID?.() ?? String(Date.now());
  const startedAt = Date.now();

  const { payload, session, topic, shop } = await authenticate.webhook(request);
  log("Received", { requestId, topic, shop, hasSession: Boolean(session) });
  if (!session) return new Response();

  const refund = payload;
  const refundId = getRefundId(refund);
  const orderNumericId = getOrderNumericId(refund);
  const refundTotalCents = getRefundTotalCentsFromPayload(refund);
  const refundMarker = refundId ? String(refundId).match(/(\d+)$/)?.[1] ?? null : null;
  const refundNotesSuffix = refundMarker ? ` [refund:${refundMarker}]` : "";

  if (!orderNumericId || refundTotalCents == null) {
    log("Skipping (missing order id or refund total)", {
      requestId,
      refundId,
      orderNumericId,
      refundTotalCents,
    });
    return new Response();
  }

  const config = await db.config.findUnique({ where: { id: 1 } });
  if (!config?.isActive || !config?.centsToOneUsd) {
    log("Skipping (inactive or not configured)", { requestId });
    return new Response();
  }

  const order = await fetchOrderSummary({ shopDomain: shop, orderNumericId });
  const orderId = order?.id ?? `gid://shopify/Order/${orderNumericId}`;
  const email = order?.email ?? order?.customer?.email ?? null;
  const shopifyCustomerId = order?.customer?.id ?? null;
  const orderTotalCents = getOrderTotalCentsForRefundMath(order);
  const clampedRefundTotalCents =
    orderTotalCents > 0 ? Math.min(refundTotalCents, orderTotalCents) : refundTotalCents;
  const refundReason =
    orderTotalCents > 0 && clampedRefundTotalCents >= orderTotalCents
      ? `Order ${orderNumericId} was refunded`
      : `Order ${orderNumericId} was partially refunded`;

  if (!email && !shopifyCustomerId) {
    log("Skipping (missing email and customer id)", { requestId, orderId });
    return new Response();
  }

  let updatedCustomerForMetafields = null;

  try {
    updatedCustomerForMetafields = await db.$transaction(async (tx) => {
      if (refundNotesSuffix) {
        const existingRefund = await tx.ledgerEntry.findFirst({
          where: {
            orderId,
            type: "ADJUST",
            notes: { contains: refundNotesSuffix },
          },
          select: { id: true },
        });

        if (existingRefund) {
          log("Skipping (refund already processed)", {
            requestId,
            orderId,
            refundId,
            existingAdjustId: existingRefund.id,
          });
          return await tx.customer.findUnique({
            where: { email },
            select: {
              currentRewardsCents: true,
              lifetimeRewardsCents: true,
              shopifyCustomerId: true,
            },
          });
        }
      }

      const customer = shopifyCustomerId
        ? await tx.customer.findFirst({
            where: { shopifyCustomerId },
            select: { id: true, currentRewardsCents: true, lifetimeRewardsCents: true, shopifyCustomerId: true },
        })
        : email
          ? await tx.customer.findUnique({
            where: { email },
            select: { id: true, currentRewardsCents: true, lifetimeRewardsCents: true, shopifyCustomerId: true },
          })
          : null;

      if (!customer) {
        log("Skipping (no customer in db)", { requestId, orderId, hasEmail: Boolean(email) });
        return null;
      }

      const earnLot = await tx.ledgerEntry.findFirst({
        where: { type: "EARN", orderId },
        select: { id: true, remainingRewardsCents: true, centsToOneUsd: true },
      });

      const earnLotRemaining = Math.max(0, earnLot?.remainingRewardsCents ?? 0);
      const effectiveCentsToOneUsd =
        earnLot?.centsToOneUsd && earnLot.centsToOneUsd > 0
          ? earnLot.centsToOneUsd
          : config.centsToOneUsd;

      const earnedToRemoveCents = computeEarnedRewardsCents({
        totalCents: clampedRefundTotalCents,
        centsToOneUsd: effectiveCentsToOneUsd,
      });
      const removableEarnedCents = Math.min(earnLotRemaining, earnedToRemoveCents);

      const spendOnOrderResult = await tx.ledgerEntry.aggregate({
        where: {
          type: "SPEND",
          orderId,
        },
        _sum: { rewardsDeltaCents: true },
      });

      const spendOnOrderCents = Math.max(0, Math.abs(spendOnOrderResult?._sum?.rewardsDeltaCents ?? 0));
      const spentRefundEstimateCents =
        orderTotalCents > 0
          ? Math.floor((spendOnOrderCents * clampedRefundTotalCents) / orderTotalCents)
          : 0;

      const alreadyRefundedSpentResult = await tx.ledgerEntry.aggregate({
        where: {
          type: "ADJUST",
          orderId,
          rewardsDeltaCents: { gt: 0 },
          notes: { startsWith: "Rewards refund from order " },
        },
        _sum: { rewardsDeltaCents: true },
      });

      const alreadyRefundedSpentCents = Math.max(
        0,
        alreadyRefundedSpentResult?._sum?.rewardsDeltaCents ?? 0,
      );

      const remainingRefundableSpentCents = Math.max(
        0,
        Math.min(spendOnOrderCents, spentRefundEstimateCents) - alreadyRefundedSpentCents,
      );

      const now = new Date();
      const refundExpiresAt = config.expirationDays
        ? new Date(now.getTime() + config.expirationDays * 24 * 60 * 60 * 1000)
        : null;

      let currentRewardsCents = customer.currentRewardsCents;

      if (remainingRefundableSpentCents > 0) {
        await tx.ledgerEntry.create({
          data: {
            customerId: customer.id,
            type: "ADJUST",
            rewardsDeltaCents: remainingRefundableSpentCents,
            remainingRewardsCents: remainingRefundableSpentCents,
            expiresAt: refundExpiresAt,
            notes: `${refundReason}${refundNotesSuffix}`,
            orderId,
          },
        });

        currentRewardsCents += remainingRefundableSpentCents;
      }

      if (removableEarnedCents > 0 && earnLot?.id) {
        await tx.ledgerEntry.update({
          where: { id: earnLot.id },
          data: { remainingRewardsCents: Math.max(0, earnLotRemaining - removableEarnedCents) },
        });

        await tx.ledgerEntry.create({
          data: {
            customerId: customer.id,
            type: "ADJUST",
            rewardsDeltaCents: -removableEarnedCents,
            centsToOneUsd: effectiveCentsToOneUsd,
            notes: `${refundReason}${refundNotesSuffix}`,
            orderId,
            sourceLotId: earnLot.id,
          },
        });

        currentRewardsCents = Math.max(0, currentRewardsCents - removableEarnedCents);
      }

      const updatedCustomer = await tx.customer.update({
        where: { id: customer.id },
        data: { currentRewardsCents },
        select: {
          currentRewardsCents: true,
          lifetimeRewardsCents: true,
          shopifyCustomerId: true,
        },
      });

      log("Processed", {
        requestId,
        orderId,
        refundId,
        refundTotalCents: clampedRefundTotalCents,
        rawRefundTotalCents: refundTotalCents,
        spendOnOrderCents,
        spentRefundEstimateCents,
        refundedSpentCents: remainingRefundableSpentCents,
        earnedToRemoveCents,
        removedEarnedCents: removableEarnedCents,
      });

      return updatedCustomer;
    });
  } catch (err) {
    error("Transaction failed", {
      requestId,
      orderNumericId,
      refundId,
      elapsedMs: Date.now() - startedAt,
      error: err?.message ?? String(err),
    });
    throw err;
  }

  if (updatedCustomerForMetafields) {
    await setCustomerRewardsMetafields({
      shopDomain: shop,
      shopifyCustomerId: updatedCustomerForMetafields.shopifyCustomerId ?? shopifyCustomerId,
      currentRewardsCents: updatedCustomerForMetafields.currentRewardsCents,
      lifetimeRewardsCents: updatedCustomerForMetafields.lifetimeRewardsCents,
    });
  }

  log("Done", { requestId, elapsedMs: Date.now() - startedAt });
  return new Response();
};
