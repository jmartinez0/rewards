import { authenticate } from "../shopify.server";
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

export const action = async ({ request }) => {
  const requestId = crypto?.randomUUID?.() ?? String(Date.now());
  const startedAt = Date.now();

  const { payload, session, topic, shop } = await authenticate.webhook(request);

  logWebhook("Received", { requestId, topic, shop, hasSession: Boolean(session) });

  if (!session) {
    logWebhook("skipping (no session)", { requestId });
    return new Response();
  }

  const order = payload;
  const email = getOrderEmail(order);
  const orderId = getOrderId(order);

  logWebhook("Parsed payload", {
    requestId,
    orderId,
    emailPresent: Boolean(email),
    processedAt: order?.processed_at ?? null,
    createdAt: order?.created_at ?? null,
    totalPrice: order?.total_price ?? null,
    totalPriceSetAmount: order?.total_price_set?.shop_money?.amount ?? null,
  });

  if (!email || !orderId) {
    logWebhook("skipping (missing email or orderId)", { requestId });
    return new Response();
  }

  const config = await db.config.findUnique({ where: { shop } });
  if (!config?.isEnabled) {
    logWebhook("skipping (rewards disabled)", { requestId });
    return new Response();
  }

  const amount =
    order?.total_price_set?.shop_money?.amount ?? order?.total_price ?? "0";
  const orderTotalCents = parseMoneyToCents(amount);
  const points = Math.floor(
    (orderTotalCents * config.pointsPerDollar) / 100,
  );

  logWebhook("Computed points", {
    requestId,
    pointsPerDollar: config.pointsPerDollar,
    pointsExpirationDays: config.pointsExpirationDays ?? null,
    orderTotalCents,
    points,
  });

  if (points <= 0) {
    logWebhook("skipping (points <= 0)", { requestId, points });
    return new Response();
  }

  const earnedAt = parseOrderDate(order?.processed_at || order?.created_at);
  const expiresAt = config.pointsExpirationDays
    ? new Date(
      earnedAt.getTime() + config.pointsExpirationDays * 24 * 60 * 60 * 1000,
    )
    : null;

  const shopifyCustomerId = getCustomerId(order);
  const name = getOrderName(order);

  try {
    await db.$transaction(async (tx) => {
      const existingEarn = await tx.ledgerEntry.findFirst({
        where: {
          shop,
          type: "EARN",
          orderId,
        },
      });

      if (existingEarn) {
        logWebhook("skipping (earn already exists)", {
          requestId,
          existingEarnId: existingEarn.id,
        });
        return;
      }

      let customer = await tx.customer.findFirst({
        where: { shop, email },
      });

      if (!customer) {
        logWebhook("creating customer", {
          requestId,
          email,
          hasShopifyCustomerId: Boolean(shopifyCustomerId),
          hasName: Boolean(name),
        });
        customer = await tx.customer.create({
          data: {
            shop,
            email,
            shopifyCustomerId,
            name,
          },
        });
      } else if (!customer.shopifyCustomerId && shopifyCustomerId) {
        logWebhook("updating customer shopifyCustomerId", {
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
      } else if (name && name !== customer.name) {
        logWebhook("updating customer name", {
          requestId,
          customerId: customer.id,
        });
        customer = await tx.customer.update({
          where: { id: customer.id },
          data: { name },
        });
      }

      logWebhook("Creating earn ledger entry", {
        requestId,
        customerId: customer.id,
        points,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        earnedAt: earnedAt.toISOString(),
        orderId,
      });

      await tx.ledgerEntry.create({
        data: {
          shop,
          customerId: customer.id,
          type: "EARN",
          pointsDelta: points,
          remainingPoints: points,
          expiresAt,
          orderId,
        },
      });

      await tx.customer.update({
        where: { id: customer.id },
        data: {
          currentPoints: { increment: points },
          lifetimePoints: { increment: points },
        },
      });
    });
  } catch (error) {
    logWebhookError("transaction failed", {
      requestId,
      orderId,
      email,
      elapsedMs: Date.now() - startedAt,
      error: error?.message ?? String(error),
    });
    throw error;
  }

  logWebhook("Done", { requestId, elapsedMs: Date.now() - startedAt });

  return new Response();
};
