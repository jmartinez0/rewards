import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";

const log = (...args) => console.log("[orders/paid]", ...args);
const error = (...args) => console.error("[orders/paid]", ...args);

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

const parsePositiveInt = (value) => {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const getCustomerGid = (shopifyCustomerId) => {
  if (!shopifyCustomerId) return null;
  const raw = String(shopifyCustomerId);
  if (raw.startsWith("gid://shopify/Customer/")) return raw;
  const match = raw.match(/(\d+)$/);
  return match ? `gid://shopify/Customer/${match[1]}` : null;
};

const getCustomerPendingRewardsMetafield = async ({ shopDomain, shopifyCustomerId }) => {
  const ownerId = getCustomerGid(shopifyCustomerId);
  if (!ownerId) return 0;

  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const query = `
      query CustomerPendingRewards($id: ID!) {
        customer(id: $id) {
          pendingRewards: metafield(namespace: "rewards", key: "pending_rewards") { value }
        }
      }
    `;

    const response = await admin.graphql(query, { variables: { id: ownerId } });
    const json = await response.json();
    return parsePositiveInt(json?.data?.customer?.pendingRewards?.value) ?? 0;
  } catch (err) {
    error("Error reading pending rewards metafield", {
      ownerId,
      error: err?.message ?? String(err),
    });
    return 0;
  }
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

const setCustomerPendingRewardsMetafield = async ({
  shopDomain,
  shopifyCustomerId,
  pendingRewardsCents,
}) => {
  const ownerId = getCustomerGid(shopifyCustomerId);
  if (!ownerId) return;

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
            ownerId,
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
      error("Failed to set pending rewards metafield", { ownerId, userErrors });
    }
  } catch (err) {
    error("Error setting pending rewards metafield", {
      ownerId,
      error: err?.message ?? String(err),
    });
  }
};

const deleteAutomaticDiscountById = async ({ shopDomain, automaticDiscountNodeId }) => {
  if (!automaticDiscountNodeId) return;

  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const deleteMutation = `
      mutation DiscountAutomaticDelete($id: ID!) {
        discountAutomaticDelete(id: $id) {
          deletedAutomaticDiscountId
          userErrors { field message }
        }
      }
    `;

    const deleteRes = await admin.graphql(deleteMutation, { variables: { id: automaticDiscountNodeId } });
    const deleteJson = await deleteRes.json();
    const userErrors = deleteJson?.data?.discountAutomaticDelete?.userErrors ?? [];
    if (userErrors.length > 0) {
      error("Failed to delete automatic discount", { automaticDiscountNodeId, userErrors });
    }
  } catch (err) {
    error("Error deleting automatic discount", {
      automaticDiscountNodeId,
      error: err?.message ?? String(err),
    });
  }
};

const getOrderId = (order) =>
  order?.admin_graphql_api_id ? order.admin_graphql_api_id : order?.id != null ? String(order.id) : null;

const getOrderEmail = (order) => order?.email || order?.customer?.email || null;

const getShopifyCustomerId = (order) =>
  order?.customer?.admin_graphql_api_id
    ? order.customer.admin_graphql_api_id
    : order?.customer?.id != null
      ? String(order.customer.id)
      : null;

const formatName = (firstName, lastName) => {
  const combined = [firstName, lastName].filter(Boolean).join(" ").trim();
  return combined ? combined.replace(/\s+/g, " ") : null;
};

const getOrderName = (order, fallback) => {
  const fromCustomer = formatName(order?.customer?.first_name, order?.customer?.last_name);
  if (fromCustomer) return fromCustomer;
  const fromBilling = formatName(order?.billing_address?.first_name, order?.billing_address?.last_name);
  if (fromBilling) return fromBilling;
  const fromShipping = formatName(order?.shipping_address?.first_name, order?.shipping_address?.last_name);
  return fromShipping || fallback || null;
};

const parseOrderDate = (value) => {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const computeEarnedRewardsCents = ({ orderTotalCents, centsToOneUsd }) => {
  if (!Number.isFinite(orderTotalCents) || orderTotalCents <= 0) return 0;
  if (!Number.isFinite(centsToOneUsd) || centsToOneUsd <= 0) return 0;
  return Math.floor((orderTotalCents * 100) / centsToOneUsd);
};

const getTrailingNumericId = (value) => {
  if (value == null) return null;
  const match = String(value).match(/(\d+)$/);
  return match ? match[1] : null;
};

const getOrderDiscountApplications = (order) => {
  if (Array.isArray(order?.discount_applications)) return order.discount_applications;
  if (Array.isArray(order?.discountApplications)) return order.discountApplications;
  return [];
};

const getDiscountAllocations = (value) => {
  if (Array.isArray(value?.discount_allocations)) return value.discount_allocations;
  if (Array.isArray(value?.discountAllocations)) return value.discountAllocations;
  return [];
};

const getAllocationIndex = (allocation) => {
  if (Number.isInteger(allocation?.discount_application_index)) {
    return allocation.discount_application_index;
  }
  if (Number.isInteger(allocation?.discountApplicationIndex)) {
    return allocation.discountApplicationIndex;
  }
  const parsedSnake = Number.parseInt(String(allocation?.discount_application_index ?? ""), 10);
  if (Number.isFinite(parsedSnake)) return parsedSnake;
  const parsedCamel = Number.parseInt(String(allocation?.discountApplicationIndex ?? ""), 10);
  if (Number.isFinite(parsedCamel)) return parsedCamel;
  return null;
};

const getUtilizedRewardsDiscountCents = ({ order, discountTitle }) => {
  const applications = getOrderDiscountApplications(order);
  if (!applications.length) return 0;

  const targetIndexes = new Set();
  applications.forEach((application, index) => {
    const title = String(application?.title ?? "");
    if (discountTitle && title === discountTitle) {
      targetIndexes.add(index);
      return;
    }
    if (!discountTitle && title.startsWith("REWARDS-")) {
      targetIndexes.add(index);
    }
  });

  if (!targetIndexes.size) return 0;

  const lineItems = Array.isArray(order?.line_items)
    ? order.line_items
    : Array.isArray(order?.lineItems)
      ? order.lineItems
      : [];

  let totalCents = 0;
  for (const line of lineItems) {
    const allocations = getDiscountAllocations(line);
    for (const allocation of allocations) {
      const index = getAllocationIndex(allocation);
      if (index == null || !targetIndexes.has(index)) continue;
      const amount =
        allocation?.amount_set?.shop_money?.amount ??
        allocation?.amountSet?.shopMoney?.amount ??
        allocation?.amount ??
        "0";
      totalCents += parseMoneyToCents(amount);
    }
  }

  return Math.max(0, totalCents);
};

export const action = async ({ request }) => {
  const requestId = crypto?.randomUUID?.() ?? String(Date.now());
  const startedAt = Date.now();

  const { payload, session, topic, shop } = await authenticate.webhook(request);
  log("Received", { requestId, topic, shop, hasSession: Boolean(session) });

  if (!session) return new Response();

  const order = payload;
  const orderId = getOrderId(order);
  const email = getOrderEmail(order);
  const shopifyCustomerId = getShopifyCustomerId(order);
  const name = getOrderName(order, email);

  if (!orderId || !email) {
    log("Skipping (missing orderId/email)", { requestId, orderId, hasEmail: Boolean(email) });
    return new Response();
  }

  const config = await db.config.findUnique({ where: { id: 1 } });
  if (!config?.isActive) {
    log("Skipping (inactive)", { requestId });
    return new Response();
  }

  const amount = order?.total_price_set?.shop_money?.amount ?? order?.total_price ?? "0";
  const orderTotalCents = parseMoneyToCents(amount);

  const earnedRewardsCents =
    config.centsToOneUsd > 0
      ? computeEarnedRewardsCents({
          orderTotalCents,
          centsToOneUsd: config.centsToOneUsd,
        })
      : 0;

  const earnedAt = parseOrderDate(order?.processed_at || order?.created_at);
  const expiresAt = config.expirationDays
    ? new Date(earnedAt.getTime() + config.expirationDays * 24 * 60 * 60 * 1000)
    : null;

  let discountCleanup = null;
  let updatedCustomerForMetafields = null;
  const pendingRewardsCents = shopifyCustomerId
    ? await getCustomerPendingRewardsMetafield({
        shopDomain: shop,
        shopifyCustomerId,
      })
    : 0;
  const orderNumericId = getTrailingNumericId(orderId);

  try {
    updatedCustomerForMetafields = await db.$transaction(async (tx) => {
      let customer = await tx.customer.findUnique({ where: { email } });

      if (!customer) {
        customer = await tx.customer.create({
          data: {
            email,
            name: name || email,
            shopifyCustomerId,
          },
        });
      } else if (shopifyCustomerId && customer.shopifyCustomerId !== shopifyCustomerId) {
        customer = await tx.customer.update({
          where: { id: customer.id },
          data: { shopifyCustomerId, ...(name && name !== customer.name ? { name } : {}) },
        });
      } else if (name && name !== customer.name) {
        customer = await tx.customer.update({
          where: { id: customer.id },
          data: { name },
        });
      }

      const existingSpend = await tx.ledgerEntry.findFirst({
        where: { type: "SPEND", orderId },
        select: { id: true },
      });

      let utilizedRewardsDiscountCents = 0;
      if (customer.shopifyCustomerId) {
        const existingDiscount = await tx.discount.findUnique({
          where: { shopifyCustomerId: customer.shopifyCustomerId },
          select: { id: true, automaticDiscountNodeId: true, discountTitle: true },
        });
        if (existingDiscount) {
          discountCleanup = existingDiscount;
        }
        utilizedRewardsDiscountCents = getUtilizedRewardsDiscountCents({
          order,
          discountTitle: existingDiscount?.discountTitle ?? null,
        });
      }

      if (
        !existingSpend &&
        utilizedRewardsDiscountCents > 0 &&
        customer.currentRewardsCents > 0
      ) {
        const lots = await tx.ledgerEntry.findMany({
          where: {
            customerId: customer.id,
            remainingRewardsCents: { gt: 0 },
            AND: [
              {
                OR: [
                  { type: "EARN" },
                  { type: "ADJUST", rewardsDeltaCents: { gt: 0 } },
                ],
              },
              {
                OR: [
                  { expiresAt: null },
                  { expiresAt: { gt: earnedAt } },
                ],
              },
            ],
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, remainingRewardsCents: true },
        });

        const totalAvailable = lots.reduce((sum, lot) => {
          const lotRemaining =
            typeof lot.remainingRewardsCents === "number" ? lot.remainingRewardsCents : 0;
          return sum + Math.max(0, lotRemaining);
        }, 0);

        let remainingToSpend = Math.min(
          utilizedRewardsDiscountCents,
          customer.currentRewardsCents,
          totalAvailable,
        );
        const targetSpendCents = remainingToSpend;

        for (const lot of lots) {
          if (remainingToSpend <= 0) break;

          const lotRemaining =
            typeof lot.remainingRewardsCents === "number" ? lot.remainingRewardsCents : 0;
          if (lotRemaining <= 0) continue;

          const take = Math.min(lotRemaining, remainingToSpend);
          remainingToSpend -= take;

          await tx.ledgerEntry.update({
            where: { id: lot.id },
            data: { remainingRewardsCents: Math.max(0, lotRemaining - take) },
          });

          await tx.ledgerEntry.create({
            data: {
              customerId: customer.id,
              type: "SPEND",
              rewardsDeltaCents: -take,
              remainingRewardsCents: null,
              expiresAt: null,
              orderId,
              sourceLotId: lot.id,
              notes: orderNumericId
                ? `Order ${orderNumericId} paid with rewards discount`
                : "Order paid with rewards discount",
              createdAt: earnedAt,
            },
          });
        }

        const spentAppliedCents = Math.max(0, targetSpendCents - remainingToSpend);

        if (spentAppliedCents > 0) {
          customer = await tx.customer.update({
            where: { id: customer.id },
            data: { currentRewardsCents: { decrement: spentAppliedCents } },
          });
        }

        if (
          pendingRewardsCents > 0 &&
          spentAppliedCents > 0 &&
          pendingRewardsCents !== spentAppliedCents
        ) {
          log("Pending rewards mismatch vs utilized discount", {
            requestId,
            orderId,
            pendingRewardsCents,
            utilizedRewardsDiscountCents,
            spentAppliedCents,
          });
        }
      }
      if (!existingSpend && utilizedRewardsDiscountCents === 0 && pendingRewardsCents > 0) {
        log("No utilized rewards discount found on order allocations", {
          requestId,
          orderId,
          pendingRewardsCents,
        });
      }

      const existingEarn = await tx.ledgerEntry.findFirst({
        where: { type: "EARN", orderId },
        select: { id: true },
      });

      if (!existingEarn && earnedRewardsCents > 0) {
        await tx.ledgerEntry.create({
          data: {
            customerId: customer.id,
            type: "EARN",
            rewardsDeltaCents: earnedRewardsCents,
            remainingRewardsCents: earnedRewardsCents,
            centsToOneUsd: config.centsToOneUsd,
            expiresAt,
            orderId,
          },
        });

        customer = await tx.customer.update({
          where: { id: customer.id },
          data: {
            currentRewardsCents: { increment: earnedRewardsCents },
            lifetimeRewardsCents: { increment: earnedRewardsCents },
          },
        });
      }

      return {
        currentRewardsCents: customer.currentRewardsCents,
        lifetimeRewardsCents: customer.lifetimeRewardsCents,
        shopifyCustomerId: customer.shopifyCustomerId,
      };
    });
  } catch (err) {
    error("Transaction failed", {
      requestId,
      orderId,
      email,
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

  if (shopifyCustomerId) {
    await setCustomerPendingRewardsMetafield({
      shopDomain: shop,
      shopifyCustomerId,
      pendingRewardsCents: 0,
    });
  }

  if (discountCleanup?.automaticDiscountNodeId) {
    await deleteAutomaticDiscountById({
      shopDomain: shop,
      automaticDiscountNodeId: discountCleanup.automaticDiscountNodeId,
    });
    await db.discount.delete({ where: { id: discountCleanup.id } });
  }

  log("Done", { requestId, elapsedMs: Date.now() - startedAt });
  return new Response();
};
