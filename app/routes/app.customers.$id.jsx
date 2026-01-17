import { useRef, useState } from "react";
import { useEffect } from "react";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const getCustomerGid = (shopifyCustomerId) => {
  if (!shopifyCustomerId) return null;
  const raw = String(shopifyCustomerId);
  if (raw.startsWith("gid://shopify/Customer/")) return raw;
  const match = raw.match(/(\d+)$/);
  return match ? `gid://shopify/Customer/${match[1]}` : null;
};

const setCustomerCurrentPointsMetafield = async ({
  admin,
  shopifyCustomerId,
  currentPoints,
}) => {
  const ownerId = getCustomerGid(shopifyCustomerId);
  if (!ownerId) return;

  try {
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
      console.error("Failed to set customer current_points metafield", {
        ownerId,
        userErrors,
      });
    }
  } catch (error) {
    console.error("Error setting customer current_points metafield", {
      ownerId,
      error: error?.message ?? String(error),
    });
  }
};

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);

  const id = Number.parseInt(params.id, 10);
  if (Number.isNaN(id)) {
    throw new Response("Invalid customer id", { status: 400 });
  }

  const customer = await db.customer.findUnique({
    where: { id },
    include: {
      ledgerEntries: {
        orderBy: { createdAt: "desc" },
        include: {
          sourceLot: true,
          depletions: {
            orderBy: { createdAt: "desc" },
          },
        },
      },
    },
  });

  if (!customer) {
    throw new Response("Customer not found", { status: 404 });
  }

  const storeSlug = session.shop.split(".")[0];

  return { customer, storeSlug };
};

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);

  const id = Number.parseInt(params.id, 10);
  if (Number.isNaN(id)) {
    throw new Response("Invalid customer id", { status: 400 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  if (intent !== "adjust_points") {
    return { ok: false, errors: { form: "Unsupported action" } };
  }

  const adjustmentType = String(formData.get("adjustmentType") ?? "");
  const adjustByRaw = String(formData.get("adjustBy") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

  const errors = {};

  const adjustBy = Number(adjustByRaw);
  if (!adjustByRaw || !Number.isFinite(adjustBy) || !Number.isInteger(adjustBy)) {
    errors.adjustBy = "Must be a number";
  }

  if (!reason) {
    errors.reason = "Reason is required";
  }

  const customer = await db.customer.findUnique({ where: { id } });
  if (!customer) {
    throw new Response("Customer not found", { status: 404 });
  }

  if (adjustmentType === "increase") {
    if (!errors.adjustBy && adjustBy <= 0) {
      errors.adjustBy = "Must be a positive integer";
    }
  } else if (adjustmentType === "decrease") {
    if (!errors.adjustBy && (adjustBy < 1 || adjustBy > customer.currentPoints)) {
      errors.adjustBy = `Must be between 1-${customer.currentPoints}`;
    }
  } else {
    errors.adjustmentType = "Select increase or decrease";
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const config = await db.config.findFirst({ orderBy: { id: "asc" } });
  const now = new Date();
  const expiresAt =
    adjustmentType === "increase" && config?.pointsExpirationDays
      ? new Date(
        now.getTime() + config.pointsExpirationDays * 24 * 60 * 60 * 1000,
      )
      : null;

  const pointsDelta = adjustmentType === "decrease" ? -adjustBy : adjustBy;
  const nextCurrentPoints = customer.currentPoints + pointsDelta;

  await db.$transaction(async (tx) => {
    if (pointsDelta > 0) {
      await tx.ledgerEntry.create({
        data: {
          customerId: customer.id,
          type: "ADJUST",
          pointsDelta,
          remainingPoints: pointsDelta,
          expiresAt,
          notes: reason,
          createdAt: now,
        },
      });
    } else {
      const adjustmentGroupId = crypto?.randomUUID?.() ?? String(Date.now());

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
            {
              OR: [
                { expiresAt: null },
                { expiresAt: { gt: now } },
              ],
            },
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          remainingPoints: true,
        },
      });

      const totalAvailable = lots.reduce((sum, lot) => {
        const lotRemaining = typeof lot.remainingPoints === "number" ? lot.remainingPoints : 0;
        return sum + Math.max(0, lotRemaining);
      }, 0);

      if (totalAvailable <= 0 || Math.abs(pointsDelta) > totalAvailable) {
        throw new Response("Not enough available points to decrease.", { status: 400 });
      }

      let remainingToRemove = Math.abs(pointsDelta);

      for (const lot of lots) {
        if (remainingToRemove <= 0) break;
        const lotRemaining = typeof lot.remainingPoints === "number" ? lot.remainingPoints : 0;
        if (lotRemaining <= 0) continue;

        const take = Math.min(lotRemaining, remainingToRemove);
        remainingToRemove -= take;

        await tx.ledgerEntry.update({
          where: { id: lot.id },
          data: { remainingPoints: Math.max(0, lotRemaining - take) },
        });

        await tx.ledgerEntry.create({
          data: {
            customerId: customer.id,
            type: "ADJUST",
            pointsDelta: -take,
            remainingPoints: null,
            expiresAt: null,
            notes: reason,
            createdAt: now,
            sourceLotId: lot.id,
            adjustmentGroupId,
          },
        });
      }
    }

    await tx.customer.update({
      where: { id: customer.id },
      data: {
        currentPoints:
          pointsDelta > 0
            ? { increment: pointsDelta }
            : { decrement: Math.abs(pointsDelta) },
        ...(pointsDelta > 0 ? { lifetimePoints: { increment: pointsDelta } } : {}),
      },
    });
  });

  await setCustomerCurrentPointsMetafield({
    admin,
    shopifyCustomerId: customer.shopifyCustomerId,
    currentPoints: nextCurrentPoints,
  });

  return { ok: true, savedAt: Date.now() };
};

export default function CustomerDetails() {
  const { customer, storeSlug } = useLoaderData();
  const [searchParams] = useSearchParams();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const lastAdjustmentSavedAtRef = useRef(null);
  const [adjustmentType, setAdjustmentType] = useState("increase");
  const [adjustBy, setAdjustBy] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjustTouched, setAdjustTouched] = useState(false);

  const ledgerEntries = Array.isArray(customer.ledgerEntries)
    ? customer.ledgerEntries
    : [];

  const historyRows = buildHistoryRows(ledgerEntries);

  const adjustByError = getAdjustByError({
    adjustmentType,
    adjustBy,
    currentPoints: customer.currentPoints,
  });
  const reasonError = getReasonError(adjustReason);
  const serverAdjustByError = fetcher.data?.errors?.adjustBy;
  const serverReasonError = fetcher.data?.errors?.reason;
  const canSaveAdjustment =
    !adjustByError && !reasonError && fetcher.state === "idle";
  const afterAdjustmentPoints = getAfterAdjustmentPoints({
    adjustmentType,
    currentPoints: customer.currentPoints,
    adjustBy,
  });

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    if (!fetcher.data?.ok || !fetcher.data?.savedAt) return;
    if (fetcher.data.savedAt === lastAdjustmentSavedAtRef.current) return;

    lastAdjustmentSavedAtRef.current = fetcher.data.savedAt;

    const modalEl = document.getElementById("adjustPoints");
    if (modalEl && typeof modalEl.hideOverlay === "function") {
      modalEl.hideOverlay();
    }

    setAdjustmentType("increase");
    setAdjustBy("");
    setAdjustReason("");
    setAdjustTouched(false);

    if (shopify?.toast) {
      shopify.toast.show("Points adjusted");
    }

    revalidator.revalidate();
  }, [fetcher.data, fetcher.state, revalidator, shopify]);

  const searchSuffix = searchParams.toString();
  const backHref = searchSuffix
    ? `/app/customers?${searchSuffix}`
    : "/app/customers";

  const numericCustomerId = getNumericCustomerId(customer.shopifyCustomerId);

  const customerAdminHref =
    numericCustomerId && storeSlug
      ? `https://admin.shopify.com/store/${storeSlug}/customers/${numericCustomerId}`
      : undefined;

  return (
    <s-page heading="Customers">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" alignItems="center" gap="small-100">
          <s-button
            variant="secondary"
            icon="arrow-left"
            href={backHref}
          />
          <s-heading>{customer.name ?? customer.email}</s-heading>
        </s-stack>

        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(300px, 1fr))" gap="base">
          <s-section>
            <s-stack direction="block" gap="base">
              <s-heading>Customer</s-heading>
              <s-text>Name: {customer.name ?? "-"}</s-text>
              <s-text>Email: {customer.email}</s-text>
              <s-text>Customer ID: {numericCustomerId && customerAdminHref ? (
                <s-link
                  href={customerAdminHref}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {numericCustomerId}
                </s-link>
              ) : (
                "N/A (Guest account)"
              )}</s-text>
            </s-stack>
          </s-section>

          <s-section>
            <s-stack direction="block" gap="base">
              <s-heading>Points</s-heading>
              <s-text>Current points: {formatNumber(customer.currentPoints)}</s-text>
              <s-text>Lifetime points: {formatNumber(customer.lifetimePoints)}</s-text>
              <s-button commandFor="adjustPoints">
                Adjust points
              </s-button>
            </s-stack>
          </s-section>
        </s-grid>

        <s-section padding="none">
          <s-stack gap="small">
            <s-box padding="base none none base">
              <s-heading>History</s-heading>
            </s-box>
            <s-table>
              <s-table-header-row>
                <s-table-header><s-box padding="none small-400">Date</s-box></s-table-header>
                <s-table-header>Type</s-table-header>
                <s-table-header>Points</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {historyRows.length ? (
                  historyRows.map((row, index) => {
                    const entry = row.kind === "single" ? row.entry : row;
                    const num = index + 1;
                    const rowId = `row-${num}`;
                    const modalId =
                      row.kind === "spend_group"
                        ? modalIdForSpendGroup(row.orderId)
                        : row.kind === "adjust_group"
                          ? modalIdForAdjustGroup(row.adjustmentGroupId)
                        : modalIdForEntry(entry.id);

                    return (
                      <s-table-row key={entry.id} clickDelegate={rowId}>
                        <s-table-cell>
                          <s-box padding="none none none small-400">{formatDateMMDDYYYY(entry.createdAt)}</s-box>
                        </s-table-cell>
                        <s-table-cell>{formatLedgerType(entry.type)}</s-table-cell>
                        <s-table-cell>{formatSignedPoints(entry.pointsDelta)}</s-table-cell>
                        <s-link id={rowId} commandFor={modalId} />
                      </s-table-row>
                    );
                  })
                ) : (
                  <s-table-row>
                    <s-table-cell>
                      <s-box padding="none small-400">-</s-box>
                    </s-table-cell>
                    <s-table-cell>-</s-table-cell>
                    <s-table-cell>-</s-table-cell>
                  </s-table-row>
                )}
              </s-table-body>
            </s-table>
          </s-stack>
        </s-section>
      </s-stack>
      {historyRows.map((row) => {
        const entry = row.kind === "single" ? row.entry : row;
        const modalId =
          row.kind === "spend_group"
            ? modalIdForSpendGroup(row.orderId)
            : row.kind === "adjust_group"
              ? modalIdForAdjustGroup(row.adjustmentGroupId)
            : modalIdForEntry(entry.id);
        const pointsLabel = getPointsLabel(entry.type, entry.pointsDelta);
        const numericOrderId = getTrailingNumericId(entry.orderId);
        const orderAdminHref =
          numericOrderId && storeSlug
            ? `https://admin.shopify.com/store/${storeSlug}/orders/${numericOrderId}`
            : undefined;
        const pointsSpentFromLots =
          entry.type === "SPEND" ? getPointsSpentFromLots(row) : null;
        const pointsRemovedFromLots =
          entry.type === "ADJUST" && entry.pointsDelta < 0
            ? getPointsRemovedFromLots(row)
            : null;
        const pointsDepletedBy =
          row.kind === "single" ? getPointsDepletedBy(entry) : null;

        return (
          <s-modal
            key={modalId}
            id={modalId}
            heading={`${formatLedgerType(entry.type)} event on ${formatDateMMDDYYYY(entry.createdAt)}`}
          >
            <s-stack direction="block" gap="small">
              <s-text>Timestamp: {formatTimestampLong(entry.createdAt)}</s-text>
              {entry.type === "EARN" || entry.type === "SPEND" ? (
                <s-text>Order ID:{" "}
                  {numericOrderId ? (
                    orderAdminHref ? (
                      <s-link
                        href={orderAdminHref}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {numericOrderId}
                      </s-link>
                    ) : (
                      numericOrderId
                    )
                  ) : (
                    "—"
                  )}
                </s-text>
              ) : null}
		              {pointsLabel ? (
		                <s-text>{pointsLabel}: {formatNumber(Math.abs(entry.pointsDelta))}</s-text>
		              ) : null}
	              {pointsRemovedFromLots && pointsRemovedFromLots.length ? (
	                <s-unordered-list>
	                  {pointsRemovedFromLots.map((lot) => (
	                    <s-list-item key={lot.key}>
	                      <s-stack
	                        direction="inline"
	                        alignItems="center"
	                        gap="small-400"
	                      >
	                        <s-text>{lot.label}</s-text>
	                        <s-icon type="info" interestFor={lot.tooltipId} />
	                      </s-stack>
	                      <s-tooltip id={lot.tooltipId}>
	                        {renderLotTooltipContent(lot.sourceLot)}
	                      </s-tooltip>
	                    </s-list-item>
	                  ))}
	                </s-unordered-list>
	              ) : null}
		              {pointsSpentFromLots ? (
		                <s-stack direction="block" gap="small-200">
		                  <s-text>Points spent from:</s-text>
	                  {pointsSpentFromLots.length ? (
                    <s-unordered-list>
                      {pointsSpentFromLots.map((lot) => (
                        <s-list-item key={lot.key}>
                          <s-stack
                            direction="inline"
                            alignItems="center"
                            gap="small-400"
                          >
                            <s-text>
                              {lot.label}
                            </s-text>
                            <s-icon
                              type="info"
                              interestFor={lot.tooltipId}
                            />
                          </s-stack>
                          <s-tooltip id={lot.tooltipId}>
                            {renderLotTooltipContent(lot.sourceLot)}
                          </s-tooltip>
                        </s-list-item>
                      ))}
                    </s-unordered-list>
                  ) : (
                    <s-text>—</s-text>
                  )}
                </s-stack>
              ) : null}
              {entry.type === "EARN" ? (
                <s-text>
                  Points remaining: {formatNumber(entry.remainingPoints)}
                </s-text>
              ) : null}
              {entry.type === "EARN" ? (
                <s-text>
                  Expires: {formatDateMMDDYYYY(entry.expiresAt)}
                </s-text>
              ) : null}
		              {entry.type === "ADJUST" ? (
			                (() => {
			                  const rawNotes =
			                    row.kind === "adjust_group"
			                      ? row.entries?.[0]?.notes
			                      : entry.notes;
			                  const reason = rawNotes?.trim();
	                  const numericReasonOrderId =
	                    reason?.startsWith("Refund from order ")
	                      ? getTrailingNumericId(reason)
	                      : null;
                  const reasonOrderAdminHref =
                    numericReasonOrderId && storeSlug
                      ? `https://admin.shopify.com/store/${storeSlug}/orders/${numericReasonOrderId}`
                      : undefined;

                  if (reason?.startsWith("Refund from order ") && numericReasonOrderId) {
                    return (
                      <s-text>
                        Reason: Refund from order{" "}
                        {reasonOrderAdminHref ? (
                          <s-link
                            href={reasonOrderAdminHref}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {numericReasonOrderId}
                          </s-link>
                        ) : (
                          numericReasonOrderId
                        )}
                      </s-text>
                    );
                  }

		                  return <s-text>Reason: {reason || "—"}</s-text>;
			                })()
			              ) : null}
	              {pointsDepletedBy && pointsDepletedBy.length ? (
	                <s-stack direction="block" gap="small-200">
	                  <s-text>Points depleted by:</s-text>
	                  <s-unordered-list>
	                    {pointsDepletedBy.map((depletion) => (
	                      <s-list-item key={depletion.key}>
	                        <s-stack
	                          direction="inline"
	                          alignItems="center"
	                          gap="small-400"
	                        >
	                          <s-text interestFor={depletion.tooltipId}>
	                            {depletion.label}
	                          </s-text>
	                          <s-icon
	                            type="info"
	                            interestFor={depletion.tooltipId}
	                          />
	                        </s-stack>
	                        <s-tooltip id={depletion.tooltipId}>
	                          <s-paragraph>{formatTimestampLong(depletion.createdAt)}</s-paragraph>
	                          {depletion.orderId ? (
	                            <s-paragraph>
	                              Order ID:{" "}
	                              {getTrailingNumericId(depletion.orderId) ?? "—"}
	                            </s-paragraph>
	                          ) : (
	                            <s-paragraph>
	                              Reason: {depletion.notes?.trim() || "—"}
	                            </s-paragraph>
	                          )}
	                        </s-tooltip>
	                      </s-list-item>
	                    ))}
	                  </s-unordered-list>
	                </s-stack>
	              ) : null}
	            </s-stack>
	          </s-modal>
	        );
	      })}
      <s-modal
        id="adjustPoints"
        heading="Adjust points"
        onAfterHide={() => {
          setAdjustBy("");
          setAdjustReason("");
          setAdjustTouched(false);
          setAdjustmentType("increase");
        }}
      >
        <s-stack direction="block" gap="base">

          <s-select
            label="Adjustment type"
            name="adjustmentType"
            value={adjustmentType}
            onChange={(event) => setAdjustmentType(event.currentTarget.value)}
          >
            <s-option value="increase">
              Increase
            </s-option>
            <s-option value="decrease">
              Decrease
            </s-option>
          </s-select>

          <s-text-field
            label={adjustmentType === "decrease" ? "Decrease by" : "Increase by"}
            name="adjustByField"
            value={adjustBy}
            onChange={(event) => setAdjustBy(event.currentTarget.value)}
            onInput={(event) => setAdjustBy(event.currentTarget.value)}
            error={adjustTouched ? (adjustByError || serverAdjustByError) : undefined}
          />

          <s-text-field
            label="Reason"
            name="reason"
            value={adjustReason}
            onChange={(event) => setAdjustReason(event.currentTarget.value)}
            onInput={(event) => setAdjustReason(event.currentTarget.value)}
            error={adjustTouched ? (reasonError || serverReasonError) : undefined}
          />

          <s-stack gap="small">
            <s-text>Current points: {formatNumber(customer.currentPoints)} points</s-text>
            <s-text>After adjustment: {formatNumber(afterAdjustmentPoints)} points</s-text>
          </s-stack>
        </s-stack>

        <s-button slot="secondary-actions" commandFor="adjustPoints" command="--hide">
          Close
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={fetcher.state !== "idle"}
          loading={fetcher.state !== "idle"}
          onClick={() => {
            setAdjustTouched(true);
            if (!canSaveAdjustment) return;
            const formData = new FormData();
            formData.set("intent", "adjust_points");
            formData.set("adjustmentType", adjustmentType);
            formData.set("adjustBy", adjustBy.trim());
            formData.set("reason", adjustReason.trim());
            fetcher.submit(formData, { method: "post" });
          }}
        >
          Save
        </s-button>
      </s-modal>

    </s-page>
  );
}

function getNumericCustomerId(shopifyCustomerId) {
  if (!shopifyCustomerId) return null;
  const match = shopifyCustomerId.match(/(\d+)$/);
  return match ? match[1] : null;
}

function getTrailingNumericId(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/(\d+)$/);
  return match ? match[1] : null;
}

function getAdjustByError({ adjustmentType, adjustBy, currentPoints }) {
  const rawValue = adjustBy.trim();
  if (!rawValue) return "Must be a number";

  const amount = Number(rawValue);
  if (!Number.isFinite(amount)) return "Must be a number";

  if (!Number.isInteger(amount)) {
    return adjustmentType === "decrease"
      ? `Must be between 1-${currentPoints}`
      : "Must be a positive integer";
  }

  if (adjustmentType === "increase") {
    if (amount <= 0) return "Must be a positive integer";
    return null;
  }

  if (adjustmentType === "decrease") {
    if (amount < 1 || amount > currentPoints) {
      return `Must be between 1-${currentPoints}`;
    }
    return null;
  }

  return "Must be a number";
}

function getReasonError(reason) {
  if (!reason.trim()) return "Reason is required";
  return null;
}

function getAfterAdjustmentPoints({ adjustmentType, currentPoints, adjustBy }) {
  const amount = Number(adjustBy.trim());
  if (!Number.isFinite(amount) || amount < 0) return currentPoints;

  if (adjustmentType === "decrease") {
    return currentPoints - amount;
  }

  return currentPoints + amount;
}

function formatDateMMDDYYYY(value) {
  if (value == null) return "Never";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  }).format(date);
}

function formatTimestampLong(value) {
  if (value == null) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  const parts = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);

  const part = (type) => parts.find((p) => p.type === type)?.value ?? "";

  const month = part("month");
  const day = part("day");
  const year = part("year");
  const hour = part("hour");
  const minute = part("minute");
  const dayPeriod = part("dayPeriod").toLowerCase();

  return `${month} ${day}, ${year} at ${hour}:${minute} ${dayPeriod}`;
}

function formatNumber(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";
  return new Intl.NumberFormat("en-US").format(value);
}

function formatSignedPoints(pointsDelta) {
  if (typeof pointsDelta !== "number" || Number.isNaN(pointsDelta)) return "-";
  if (pointsDelta > 0) return `+${formatNumber(pointsDelta)}`;
  return formatNumber(pointsDelta);
}

function formatLedgerType(type) {
  switch (type) {
    case "EARN":
      return "Earn";
    case "SPEND":
      return "Spend";
    case "ADJUST":
      return "Adjust";
    case "EXPIRE":
      return "Expire";
    default:
      return type;
  }
}

function getPointsLabel(type, pointsDelta) {
  if (type === "EARN") return "Points earned";
  if (type === "SPEND") return "Points spent";

  if (type === "ADJUST") {
    if (pointsDelta > 0) return "Points added";
    if (pointsDelta < 0) return "Points removed";
  }

  return null;
}

function toSafeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "-");
}

function modalIdForEntry(entryId) {
  return `modal-entry-${entryId}`;
}

function modalIdForSpendGroup(orderId) {
  return `modal-spend-${toSafeId(orderId)}`;
}

function modalIdForAdjustGroup(adjustmentGroupId) {
  return `modal-adjust-${toSafeId(adjustmentGroupId)}`;
}

function buildHistoryRows(entries) {
  const spendGroups = new Map();
  const adjustGroups = new Map();

  entries.forEach((entry, index) => {
    if (entry.type !== "SPEND" || !entry.orderId) return;
    const existing = spendGroups.get(entry.orderId);
    if (!existing) {
      spendGroups.set(entry.orderId, { firstIndex: index, entries: [entry] });
      return;
    }
    existing.entries.push(entry);
  });

  entries.forEach((entry, index) => {
    if (entry.type !== "ADJUST" || entry.pointsDelta >= 0) return;
    if (!entry.adjustmentGroupId) return;
    const existing = adjustGroups.get(entry.adjustmentGroupId);
    if (!existing) {
      adjustGroups.set(entry.adjustmentGroupId, { firstIndex: index, entries: [entry] });
      return;
    }
    existing.entries.push(entry);
  });

  const rows = [];

  entries.forEach((entry, index) => {
    if (entry.type === "SPEND" && entry.orderId) {
      const group = spendGroups.get(entry.orderId);
      if (!group || group.firstIndex !== index) return;

      const pointsDelta = group.entries.reduce(
        (sum, spendEntry) => sum + spendEntry.pointsDelta,
        0
      );

      rows.push({
        kind: "spend_group",
        id: `spend:${entry.orderId}`,
        type: "SPEND",
        pointsDelta,
        createdAt: entry.createdAt,
        orderId: entry.orderId,
        entries: group.entries,
      });
      return;
    }

    if (entry.type === "ADJUST" && entry.pointsDelta < 0 && entry.adjustmentGroupId) {
      const group = adjustGroups.get(entry.adjustmentGroupId);
      if (!group || group.firstIndex !== index) return;

      const pointsDelta = group.entries.reduce(
        (sum, adjustEntry) => sum + adjustEntry.pointsDelta,
        0
      );

      rows.push({
        kind: "adjust_group",
        id: `adjust:${entry.adjustmentGroupId}`,
        type: "ADJUST",
        pointsDelta,
        createdAt: entry.createdAt,
        adjustmentGroupId: entry.adjustmentGroupId,
        entries: group.entries,
      });
      return;
    }

    rows.push({ kind: "single", entry });
  });

  return rows;
}

function getPointsSpentFromLots(row) {
  const spendEntries =
    row && row.kind === "spend_group" && Array.isArray(row.entries)
      ? row.entries
      : row && row.kind === "single"
        ? [row.entry]
        : [];

  const rowKey =
    row && row.kind === "spend_group"
      ? `spend-${toSafeId(row.orderId)}`
      : row && row.kind === "single"
        ? `entry-${row.entry?.id ?? "unknown"}`
        : "unknown";

  const byLotId = new Map();

  spendEntries.forEach((spendEntry) => {
    const lotId = spendEntry?.sourceLotId;
    if (!lotId) return;

    const existing = byLotId.get(lotId) ?? {
      lotId,
      earn: spendEntry?.sourceLot,
      spent: 0,
    };

    existing.spent += Math.abs(spendEntry?.pointsDelta ?? 0);
    if (!existing.earn && spendEntry?.sourceLot) existing.earn = spendEntry.sourceLot;

    byLotId.set(lotId, existing);
  });

  return Array.from(byLotId.values())
    .sort((a, b) => a.lotId - b.lotId)
    .map((item) => {
      const sourceType = item.earn?.type;
      const sourceCreatedAt = item.earn?.createdAt
        ? formatDateMMDDYYYY(item.earn.createdAt)
        : "—";

      const sourceLabel =
        sourceType === "EARN"
          ? `Earned ${sourceCreatedAt}`
          : sourceType === "ADJUST"
            ? `Added ${sourceCreatedAt}`
            : `Source ${sourceCreatedAt}`;

      const parts = [
        `${formatNumber(item.spent)} points`,
        sourceLabel,
      ];

      return {
        key: String(item.lotId),
        tooltipId: `tooltip-${rowKey}-lot-${item.lotId}`,
        label: parts.join(" - "),
        sourceLot: item.earn ?? null,
      };
    });
}

function getPointsRemovedFromLots(row) {
  const adjustmentEntries =
    row && row.kind === "adjust_group" && Array.isArray(row.entries)
      ? row.entries
      : row && row.kind === "single"
        ? [row.entry]
        : [];

  const rowKey =
    row && row.kind === "adjust_group"
      ? `adjust-${toSafeId(row.adjustmentGroupId)}`
      : row && row.kind === "single"
        ? `entry-${row.entry?.id ?? "unknown"}`
        : "unknown";

  const byLotId = new Map();

  adjustmentEntries.forEach((adjustEntry) => {
    if (adjustEntry?.type !== "ADJUST" || !(adjustEntry?.pointsDelta < 0)) return;
    const lotId = adjustEntry?.sourceLotId;
    if (!lotId) return;

    const existing = byLotId.get(lotId) ?? {
      lotId,
      sourceLot: adjustEntry?.sourceLot,
      removed: 0,
    };

    existing.removed += Math.abs(adjustEntry?.pointsDelta ?? 0);
    if (!existing.sourceLot && adjustEntry?.sourceLot) existing.sourceLot = adjustEntry.sourceLot;

    byLotId.set(lotId, existing);
  });

  return Array.from(byLotId.values())
    .sort((a, b) => a.lotId - b.lotId)
    .map((item) => {
      const sourceType = item.sourceLot?.type;
      const sourceCreatedAt = item.sourceLot?.createdAt
        ? formatDateMMDDYYYY(item.sourceLot.createdAt)
        : null;

      const sourceLabel =
        sourceType === "EARN"
          ? `Earned ${sourceCreatedAt}`
          : sourceType === "ADJUST"
            ? `Added ${sourceCreatedAt}`
            : `Source ${sourceCreatedAt}`;

      const parts = [
        `${formatNumber(item.removed)} points`,
        sourceLabel,
      ];

      return {
        key: String(item.lotId),
        tooltipId: `tooltip-${rowKey}-lot-${item.lotId}`,
        label: parts.join(" - "),
        sourceLot: item.sourceLot ?? null,
      };
    });
}

function getPointsDepletedBy(entry) {
  const isSourceLot =
    entry?.type === "EARN" || (entry?.type === "ADJUST" && entry?.pointsDelta > 0);
  if (!isSourceLot) return null;

  const depletions = Array.isArray(entry.depletions) ? entry.depletions : [];
  const entryKey = `lot-${entry.id}`;

  return depletions
    .filter((d) => {
      if (d?.type === "SPEND" || d?.type === "EXPIRE") return true;
      return d?.type === "ADJUST" && d?.pointsDelta < 0;
    })
    .map((d) => {
      const notes = String(d?.notes ?? "").trim();
      const isRefund = notes.startsWith("Refund from order ");

      return {
        key: String(d.id),
        tooltipId: `tooltip-${entryKey}-depletion-${d.id}`,
        createdAt: d.createdAt,
        orderId: d.orderId,
        notes,
        label: `${isRefund ? "Refund" : formatLedgerType(d.type)} ${Math.abs(d.pointsDelta)} points`,
      };
    });
}

function renderLotTooltipContent(sourceLot) {
  if (!sourceLot) return "—";

  if (sourceLot.type === "EARN") {
    const numericOrderId = getTrailingNumericId(sourceLot.orderId);

    return (
      <>
        <s-paragraph>{formatTimestampLong(sourceLot.createdAt)}</s-paragraph>
        <s-paragraph>Order ID: {numericOrderId ?? "—"}</s-paragraph>
        <s-paragraph>Points earned: {formatNumber(sourceLot.pointsDelta)}</s-paragraph>
        <s-paragraph>Points remaining: {formatNumber(sourceLot.remainingPoints)}</s-paragraph>
        <s-paragraph>Expires: {formatDateMMDDYYYY(sourceLot.expiresAt)}</s-paragraph>
      </>
    );
  }

  if (sourceLot.type === "ADJUST" && sourceLot.pointsDelta > 0) {
    return (
      <>
        <s-paragraph>{formatTimestampLong(sourceLot.createdAt)}</s-paragraph>
        <s-paragraph>Points added: {sourceLot.pointsDelta}</s-paragraph>
        <s-paragraph>Points remaining: {formatNumber(sourceLot.remainingPoints)}</s-paragraph>
      </>
    );
  }

  return (
    <>
      <s-text>Timestamp: {formatTimestampLong(sourceLot.createdAt)}</s-text>
      <s-text>Type: {formatLedgerType(sourceLot.type)}</s-text>
      <s-text>Points: {sourceLot.pointsDelta}</s-text>
      <s-text>Points remaining: {formatNumber(sourceLot.remainingPoints)}</s-text>
    </>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
