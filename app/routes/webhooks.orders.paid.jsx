import { authenticate } from "../shopify.server";
import db from "../db.server";

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
  const { payload, session, topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!session) {
    return new Response();
  }

  const order = payload;
  const email = getOrderEmail(order);
  const orderId = getOrderId(order);

  if (!email || !orderId) {
    return new Response();
  }

  const config = await db.rewardsConfig.findUnique({ where: { id: 1 } });
  if (!config?.isEnabled) {
    return new Response();
  }

  const amount =
    order?.total_price_set?.shop_money?.amount ?? order?.total_price ?? "0";
  const orderTotalCents = parseMoneyToCents(amount);
  const points = Math.floor(
    (orderTotalCents * config.pointsPerDollar) / 100,
  );

  if (points <= 0) {
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

  await db.$transaction(async (tx) => {
    const existingEarn = await tx.rewardsLedgerEntry.findFirst({
      where: {
        type: "EARN",
        orderId,
      },
    });

    if (existingEarn) {
      return;
    }

    let rewardsCustomer = await tx.rewardsCustomer.findUnique({
      where: { email },
    });

    if (!rewardsCustomer) {
      rewardsCustomer = await tx.rewardsCustomer.create({
        data: {
          email,
          shopifyCustomerId,
          name,
        },
      });
    } else if (!rewardsCustomer.shopifyCustomerId && shopifyCustomerId) {
      rewardsCustomer = await tx.rewardsCustomer.update({
        where: { id: rewardsCustomer.id },
        data: {
          shopifyCustomerId,
          ...(name && name !== rewardsCustomer.name ? { name } : {}),
        },
      });
    } else if (name && name !== rewardsCustomer.name) {
      rewardsCustomer = await tx.rewardsCustomer.update({
        where: { id: rewardsCustomer.id },
        data: { name },
      });
    }

    await tx.rewardsLedgerEntry.create({
      data: {
        rewardsCustomerId: rewardsCustomer.id,
        type: "EARN",
        pointsDelta: points,
        remainingPoints: points,
        expiresAt,
        orderId
      },
    });

    await tx.rewardsCustomer.update({
      where: { id: rewardsCustomer.id },
      data: {
        currentPoints: { increment: points },
        lifetimePoints: { increment: points },
      },
    });
  });

  return new Response();
};
