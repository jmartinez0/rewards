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

const getNoteAttributesMap = (order) => {
  const entries = Array.isArray(order?.note_attributes) ? order.note_attributes : [];
  const map = new Map();
  for (const entry of entries) {
    const name = entry?.name != null ? String(entry.name) : "";
    if (!name) continue;
    map.set(name, entry?.value != null ? String(entry.value) : "");
  }
  return map;
};

const getDiscountAmountCentsForCode = (order, code) => {
  if (!code) return 0;
  const codes = Array.isArray(order?.discount_codes) ? order.discount_codes : [];
  const normalizedTarget = String(code).trim().toLowerCase();
  if (!normalizedTarget) return 0;

  let total = 0;
  for (const discount of codes) {
    const discountCode = String(discount?.code ?? "").trim().toLowerCase();
    if (!discountCode || discountCode !== normalizedTarget) continue;
    total += parseMoneyToCents(discount?.amount ?? "0");
  }

  if (total > 0) return total;

  const fallback =
    order?.total_discounts_set?.shop_money?.amount ?? order?.total_discounts;
  return parseMoneyToCents(fallback ?? "0");
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
  } catch (error) {
    error("Error setting customer rewards metafields", {
      ownerId,
      error: error?.message ?? String(error),
    });
  }
};

const deleteDiscountCodeByCode = async ({ shopDomain, code }) => {
  if (!code) return;

  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const lookupQuery = `
      query CodeDiscountNodeByCode($code: String!) {
        codeDiscountNodeByCode(code: $code) { id }
      }
    `;
    const lookupRes = await admin.graphql(lookupQuery, { variables: { code } });
    const lookupJson = await lookupRes.json();
    const nodeId = lookupJson?.data?.codeDiscountNodeByCode?.id ?? null;
    if (!nodeId) return;

    const deleteMutation = `
      mutation DiscountCodeDelete($id: ID!) {
        discountCodeDelete(id: $id) {
          deletedCodeDiscountId
          userErrors { field message }
        }
      }
    `;

    const deleteRes = await admin.graphql(deleteMutation, { variables: { id: nodeId } });
    const deleteJson = await deleteRes.json();
    const userErrors = deleteJson?.data?.discountCodeDelete?.userErrors ?? [];
    if (userErrors.length > 0) {
      error("Failed to delete discount code", { code, userErrors });
    }
  } catch (error) {
    error("Error deleting discount code", { code, error: error?.message ?? String(error) });
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

  const noteAttributes = getNoteAttributesMap(order);
  const spendRequestedCents = parsePositiveInt(noteAttributes.get("Rewards spent"));
  const discountCode = noteAttributes.get("Rewards discount code") || null;

  const amount = order?.total_price_set?.shop_money?.amount ?? order?.total_price ?? "0";
  const orderTotalCents = parseMoneyToCents(amount);
  const spendAppliedCents = spendRequestedCents
    ? Math.min(
        spendRequestedCents,
        Math.max(0, getDiscountAmountCentsForCode(order, discountCode)),
      ) || spendRequestedCents
    : null;

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

  let shouldDeleteDiscountCode = false;
  let updatedCustomerForMetafields = null;

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

      if (spendAppliedCents) {
        const existingSpend = await tx.ledgerEntry.findFirst({
          where: { type: "SPEND", orderId },
          select: { id: true },
        });

        if (existingSpend) {
          shouldDeleteDiscountCode = Boolean(discountCode);
        } else {
          const availableRewardsCents = Math.max(0, customer.currentRewardsCents);
          if (spendAppliedCents > availableRewardsCents) {
            log("Skipping spend (insufficient balance)", {
              requestId,
              customerId: customer.id,
              orderId,
              spendRequestedCents: spendAppliedCents,
              availableRewardsCents,
            });
          } else {
            const now = new Date();
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
                  { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
                ],
              },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: { id: true, remainingRewardsCents: true },
            });

            let remainingToSpend = spendAppliedCents;

            for (const lot of lots) {
              if (remainingToSpend <= 0) break;
              const available = Math.max(0, lot.remainingRewardsCents ?? 0);
              if (!available) continue;

              const take = Math.min(available, remainingToSpend);
              remainingToSpend -= take;

              await tx.ledgerEntry.update({
                where: { id: lot.id },
                data: { remainingRewardsCents: Math.max(0, available - take) },
              });

              await tx.ledgerEntry.create({
                data: {
                  customerId: customer.id,
                  type: "SPEND",
                  rewardsDeltaCents: -take,
                  sourceLotId: lot.id,
                  orderId,
                  notes: discountCode ? `Spend (code ${discountCode})` : "Spend",
                },
              });
            }

            if (remainingToSpend > 0) {
              error("Spend allocation did not cover request", {
                requestId,
                customerId: customer.id,
                orderId,
                spendRequestedCents: spendAppliedCents,
                remainingToSpend,
              });
            }

            customer = await tx.customer.update({
              where: { id: customer.id },
              data: { currentRewardsCents: { decrement: spendAppliedCents } },
            });

            shouldDeleteDiscountCode = Boolean(discountCode);
          }
        }
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
  } catch (error) {
    error("Transaction failed", {
      requestId,
      orderId,
      email,
      elapsedMs: Date.now() - startedAt,
      error: error?.message ?? String(error),
    });
    throw error;
  }

  if (shouldDeleteDiscountCode && discountCode) {
    await deleteDiscountCodeByCode({ shopDomain: shop, code: discountCode });
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
