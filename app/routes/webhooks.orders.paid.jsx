import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";

const logWebhook = (...args) => {
  console.log("[orders/paid]", ...args);
};

const logWebhookError = (...args) => {
  console.error("[orders/paid]", ...args);
};

const parseMoneyToCents = (amount) => {
  if (amount == null) {
    return 0;
  }

  const normalized = String(amount).trim();
  if (!normalized) {
    return 0;
  }

  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [wholePart, fracPart = ""] = unsigned.split(".");
  const whole = Number(wholePart || "0");
  const frac = Number((fracPart + "00").slice(0, 2));
  const cents = whole * 100 + frac;

  return negative ? -cents : cents;
};

const getOrderEmail = (order) => {
  return order?.email || order?.customer?.email || null;
};

const getOrderId = (order) => {
  if (order?.admin_graphql_api_id) {
    return order.admin_graphql_api_id;
  }
  if (order?.id != null) {
    return String(order.id);
  }
  return null;
};

const getCustomerId = (order) => {
  if (order?.customer?.admin_graphql_api_id) {
    return order.customer.admin_graphql_api_id;
  }
  if (order?.customer?.id != null) {
    return String(order.customer.id);
  }
  return null;
};

const formatName = (firstName, lastName) => {
  const combined = [firstName, lastName].filter(Boolean).join(" ").trim();
  return combined ? combined.replace(/\s+/g, " ") : null;
};

const getOrderName = (order) => {
  const customer = order?.customer;
  const billing = order?.billing_address;
  const shipping = order?.shipping_address;

  const fromCustomer = formatName(customer?.first_name, customer?.last_name);
  if (fromCustomer) return fromCustomer;

  const fromBilling = formatName(billing?.first_name, billing?.last_name);
  if (fromBilling) return fromBilling;

  return formatName(shipping?.first_name, shipping?.last_name);
};

const parseOrderDate = (value) => {
  if (!value) {
    return new Date();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }
  return parsed;
};

const getNoteAttributesMap = (order) => {
  const entries = Array.isArray(order?.note_attributes)
    ? order.note_attributes
    : [];
  const map = new Map();
  for (const entry of entries) {
    const name = entry?.name != null ? String(entry.name) : "";
    if (!name) continue;
    map.set(name, entry?.value != null ? String(entry.value) : "");
  }
  return map;
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

const deleteDiscountCodeByCode = async ({ shopDomain, code }) => {
  if (!code) return;
  try {
    const { admin } = await unauthenticated.admin(shopDomain);

    const lookupQuery = `
      query CodeDiscountNodeByCode($code: String!) {
        codeDiscountNodeByCode(code: $code) {
          id
        }
      }
    `;

    const lookupRes = await admin.graphql(lookupQuery, { variables: { code } });
    const lookupJson = await lookupRes.json();
    const nodeId = lookupJson?.data?.codeDiscountNodeByCode?.id ?? null;
    if (!nodeId) {
      logWebhook("Discount code not found", { code });
      return;
    }

    const deleteMutation = `
      mutation DiscountCodeDelete($id: ID!) {
        discountCodeDelete(id: $id) {
          deletedCodeDiscountId
          userErrors {
            field
            message
          }
        }
      }
    `;

    const deleteRes = await admin.graphql(deleteMutation, { variables: { id: nodeId } });
    const deleteJson = await deleteRes.json();
    const userErrors = deleteJson?.data?.discountCodeDelete?.userErrors ?? [];
    if (userErrors.length > 0) {
      logWebhookError("Failed to delete discount code", { code, userErrors });
      return;
    }

    logWebhook("Deleted discount code", { code });
  } catch (error) {
    logWebhookError("Error deleting discount code", {
      code,
      error: error?.message ?? String(error),
    });
  }
};

export const action = async ({ request }) => {
  const requestId = crypto?.randomUUID?.() ?? String(Date.now());
  const startedAt = Date.now();

  const { payload, session, topic, shop } = await authenticate.webhook(request);

  logWebhook("Received", { requestId, topic, shop, hasSession: Boolean(session) });

  if (!session) {
    logWebhook("Skipping (no session)", { requestId });
    return new Response();
  }

  const order = payload;
  const email = getOrderEmail(order);
  const orderId = getOrderId(order);
  const shopifyCustomerId = getCustomerId(order);
  const name = getOrderName(order) ?? email;
  const noteAttributes = getNoteAttributesMap(order);
  const pointsToSpendRequested = parsePositiveInt(noteAttributes.get("Points spent"));
  const pointsDiscountCode = noteAttributes.get("Points discount code") || null;
  const pointsSpendEnabled = Boolean(pointsToSpendRequested);

  logWebhook("Parsed payload", {
    requestId,
    orderId,
    emailPresent: Boolean(email),
    shopifyCustomerIdPresent: Boolean(shopifyCustomerId),
    processedAt: order?.processed_at ?? null,
    createdAt: order?.created_at ?? null,
    totalPrice: order?.total_price ?? null,
    totalPriceSetAmount: order?.total_price_set?.shop_money?.amount ?? null,
    pointsSpendEnabled,
    pointsToSpendRequested,
    hasPointsDiscountCode: Boolean(pointsDiscountCode),
  });

  if (!email || !orderId) {
    logWebhook("Skipping (missing email or orderId)", { requestId });
    return new Response();
  }

  const config = await db.config.findFirst({ orderBy: { id: "asc" } });
  if (!config?.isActive) {
    logWebhook("Skipping (rewards disabled)", { requestId });
    return new Response();
  }

  const amount =
    order?.total_price_set?.shop_money?.amount ?? order?.total_price ?? "0";
  const orderTotalCents = parseMoneyToCents(amount);
  const pointsEarned =
    config?.configuredPointsPerDollar && config.pointsPerDollar > 0
      ? Math.floor((orderTotalCents * config.pointsPerDollar) / 100)
      : 0;

  logWebhook("Computed points earned", {
    requestId,
    pointsPerDollar: config.pointsPerDollar,
    pointsExpirationDays: config.pointsExpirationDays ?? null,
    orderTotalCents,
    pointsEarned,
  });

  const earnedAt = parseOrderDate(order?.processed_at || order?.created_at);
  const expiresAt = config.pointsExpirationDays
    ? new Date(
      earnedAt.getTime() + config.pointsExpirationDays * 24 * 60 * 60 * 1000,
    )
    : null;

  let updatedCustomerForMetafield = null;
  let shouldDeleteDiscountCode = false;

  try {
    updatedCustomerForMetafield = await db.$transaction(async (tx) => {
      let customer = await tx.customer.findFirst({ where: { email } });

      if (!customer) {
        logWebhook("Creating customer", {
          requestId,
          email,
          hasShopifyCustomerId: Boolean(shopifyCustomerId),
          hasName: Boolean(name),
        });
        customer = await tx.customer.create({
          data: {
            email,
            shopifyCustomerId,
            name,
          },
        });
      } else if (!customer.shopifyCustomerId && shopifyCustomerId) {
        logWebhook("Updating customer shopifyCustomerId", {
          requestId,
          customerId: customer.id,
          hasNameUpdate: Boolean(name && name !== customer.name),
        });
        customer = await tx.customer.update({
          where: { id: customer.id },
          data: {
            shopifyCustomerId,
            ...(name && name !== customer.name ? { name } : {}),
          },
        });
      } else if (shopifyCustomerId && customer.shopifyCustomerId !== shopifyCustomerId) {
        logWebhook("Updating customer shopifyCustomerId (mismatch)", {
          requestId,
          customerId: customer.id,
        });
        customer = await tx.customer.update({
          where: { id: customer.id },
          data: {
            shopifyCustomerId,
          },
        });
      } else if (name && name !== customer.name) {
        logWebhook("Updating customer name", {
          requestId,
          customerId: customer.id,
        });
        customer = await tx.customer.update({
          where: { id: customer.id },
          data: { name },
        });
      }

      if (pointsSpendEnabled && pointsToSpendRequested) {
        if (!shopifyCustomerId) {
          logWebhook("Skipping spend (no shopifyCustomerId)", { requestId });
        } else {
          const existingSpend = await tx.ledgerEntry.findFirst({
            where: {
              type: "SPEND",
              orderId,
            },
            select: { id: true },
          });

          if (existingSpend) {
            logWebhook("Skipping spend (spend already exists)", {
              requestId,
              existingSpendId: existingSpend.id,
            });
            shouldDeleteDiscountCode = Boolean(pointsDiscountCode);
          } else {
            const spendablePoints = Math.max(0, customer.currentPoints);
            const pointsToSpend = Math.min(pointsToSpendRequested, spendablePoints);

            if (pointsToSpendRequested > spendablePoints) {
              logWebhook("Spend exceeds available points", {
                requestId,
                customerId: customer.id,
                orderId,
                pointsToSpendRequested,
                spendablePoints,
                pointsToSpend,
              });
            }

            logWebhook("Processing spend", {
              requestId,
              customerId: customer.id,
              orderId,
              pointsToSpendRequested,
              pointsToSpend,
              spendablePoints,
            });

            if (pointsToSpend > 0) {
              const now = new Date();
              const lots = await tx.ledgerEntry.findMany({
                where: {
                  customerId: customer.id,
                  remainingPoints: { gt: 0 },
                  AND: [
                    {
                      OR: [
                        { type: "EARN" },
                        { type: "ADJUST", pointsDelta: { gt: 0 } },
                      ],
                    },
                    { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
                  ],
                },
                orderBy: { createdAt: "asc" },
                select: { id: true, remainingPoints: true },
              });

              let remainingToSpend = pointsToSpend;

              for (const lot of lots) {
                if (remainingToSpend <= 0) break;
                const available = Math.max(0, lot.remainingPoints ?? 0);
                if (available <= 0) continue;
                const take = Math.min(available, remainingToSpend);
                if (take <= 0) continue;

                await tx.ledgerEntry.create({
                  data: {
                    customerId: customer.id,
                    type: "SPEND",
                    pointsDelta: -take,
                    sourceLotId: lot.id,
                    orderId,
                    notes: pointsDiscountCode
                      ? `Spent ${pointsToSpend} points (code ${pointsDiscountCode})`
                      : `Spent ${pointsToSpend} points`,
                  },
                });

                await tx.ledgerEntry.update({
                  where: { id: lot.id },
                  data: {
                    remainingPoints: Math.max(0, available - take),
                  },
                });

                remainingToSpend -= take;
              }

              const spent = pointsToSpend - remainingToSpend;
              if (spent > 0) {
                customer = await tx.customer.update({
                  where: { id: customer.id },
                  data: {
                    currentPoints: { decrement: spent },
                  },
                });

                shouldDeleteDiscountCode = Boolean(pointsDiscountCode);
              }
            }
          }
        }
      }

      const existingEarn = await tx.ledgerEntry.findFirst({
        where: {
          type: "EARN",
          orderId,
        },
      });

      if (existingEarn) {
        logWebhook("Skipping (earn already exists)", {
          requestId,
          existingEarnId: existingEarn.id,
        });

        const existingCustomer = await tx.customer.findFirst({
          where: { email },
          select: {
            currentPoints: true,
            shopifyCustomerId: true,
          },
        });

        if (
          existingCustomer?.shopifyCustomerId == null &&
          shopifyCustomerId
        ) {
          const updated = await tx.customer.update({
            where: { email },
            data: { shopifyCustomerId },
            select: {
              currentPoints: true,
              shopifyCustomerId: true,
            },
          });
          return updated;
        }

        return existingCustomer;
      }

      if (pointsEarned <= 0) {
        logWebhook("Skipping earn (pointsEarned <= 0)", { requestId, pointsEarned });
        const updated = await tx.customer.findUnique({
          where: { email },
          select: {
            currentPoints: true,
            shopifyCustomerId: true,
          },
        });
        return updated;
      }

      logWebhook("Creating earn ledger entry", {
        requestId,
        customerId: customer.id,
        points: pointsEarned,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        earnedAt: earnedAt.toISOString(),
        orderId,
      });

      await tx.ledgerEntry.create({
        data: {
          customerId: customer.id,
          type: "EARN",
          pointsDelta: pointsEarned,
          remainingPoints: pointsEarned,
          pointsPerDollar: config.pointsPerDollar,
          expiresAt,
          orderId,
        },
      });

      const updatedCustomer = await tx.customer.update({
        where: { id: customer.id },
        data: {
          currentPoints: { increment: pointsEarned },
          lifetimePoints: { increment: pointsEarned },
        },
        select: {
          currentPoints: true,
          shopifyCustomerId: true,
        },
      });

      return updatedCustomer;
    });
  } catch (error) {
    logWebhookError("Transaction failed", {
      requestId,
      orderId,
      email,
      elapsedMs: Date.now() - startedAt,
      error: error?.message ?? String(error),
    });
    throw error;
  }

  logWebhook("Done", { requestId, elapsedMs: Date.now() - startedAt });

  if (shouldDeleteDiscountCode && pointsDiscountCode) {
    await deleteDiscountCodeByCode({ shopDomain: shop, code: pointsDiscountCode });
  }

  if (updatedCustomerForMetafield) {
    await setCustomerCurrentPointsMetafield({
      shopDomain: shop,
      shopifyCustomerId: updatedCustomerForMetafield.shopifyCustomerId,
      currentPoints: updatedCustomerForMetafield.currentPoints,
    });
  } else if (shopifyCustomerId) {
    const customer = await db.customer.findUnique({
      where: { email },
      select: {
        currentPoints: true,
        shopifyCustomerId: true,
      },
    });
    if (customer) {
      await setCustomerCurrentPointsMetafield({
        shopDomain: shop,
        shopifyCustomerId: customer.shopifyCustomerId ?? shopifyCustomerId,
        currentPoints: customer.currentPoints,
      });
    }
  }

  return new Response();
};
