import { useState } from "react";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);

  const id = Number.parseInt(params.id, 10);
  if (Number.isNaN(id)) {
    throw new Response("Invalid customer id", { status: 400 });
  }

  const customer = await db.rewardsCustomer.findUnique({
    where: { id },
    include: {
      rewardsLedgerEntries: {
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

export default function CustomerDetails() {
  const { customer, storeSlug } = useLoaderData();
  const [searchParams] = useSearchParams();
  const [adjustmentType, setAdjustmentType] = useState("increase");

  const ledgerEntries = Array.isArray(customer.rewardsLedgerEntries)
    ? customer.rewardsLedgerEntries
    : [];

  const historyRows = buildHistoryRows(ledgerEntries);

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
          <s-heading>{customer.name}</s-heading>
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
              <s-button commandFor="adjustPoints">Adjust points</s-button>
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
                        : modalIdForEntry(entry.id);

                    return (
                      <s-table-row key={entry.id} clickDelegate={rowId}>
                        <s-table-cell>
                          <s-box padding="none none none small-400">{formatDateMMDDYYYY(entry.createdAt)}</s-box>
                        </s-table-cell>
                        <s-table-cell>{formatLedgerType(entry.type)}</s-table-cell>
                        <s-table-cell>{entry.pointsDelta}</s-table-cell>
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
            : modalIdForEntry(entry.id);
        const pointsLabel = getPointsLabel(entry.type, entry.pointsDelta);
        const numericOrderId = getTrailingNumericId(entry.orderId);
        const orderAdminHref =
          numericOrderId && storeSlug
            ? `https://admin.shopify.com/store/${storeSlug}/orders/${numericOrderId}`
            : undefined;
        const pointsSpentFromLots =
          entry.type === "SPEND" ? getPointsSpentFromLots(row) : null;
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
                <s-text>{pointsLabel}: {Math.abs(entry.pointsDelta)}</s-text>
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
                          <s-paragraph>
                            Order ID:{" "}
                            {getTrailingNumericId(depletion.orderId) ?? "—"}
                          </s-paragraph>
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
      <s-modal id="adjustPoints" heading="Adjust points">
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
          />

          <s-text-field
            label="Reason"
            name="reason"
          />

          <s-stack gap="small">
            <s-text>Current points: {formatNumber(customer.currentPoints)} points</s-text>
            <s-text>After adjustment: {formatNumber(customer.currentPoints)} points</s-text>
          </s-stack>
        </s-stack>

        <s-button slot="secondary-actions" commandFor="adjustPoints" command="--hide">
          Close
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="adjustPoints"
          command="--hide"
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

function formatDateMMDDYYYY(value) {
  if (value == null) return "—";
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

function buildHistoryRows(entries) {
  const spendGroups = new Map();

  entries.forEach((entry, index) => {
    if (entry.type !== "SPEND" || !entry.orderId) return;
    const existing = spendGroups.get(entry.orderId);
    if (!existing) {
      spendGroups.set(entry.orderId, { firstIndex: index, entries: [entry] });
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

function getPointsDepletedBy(entry) {
  const isSourceLot =
    entry?.type === "EARN" || (entry?.type === "ADJUST" && entry?.pointsDelta > 0);
  if (!isSourceLot) return null;

  const depletions = Array.isArray(entry.depletions) ? entry.depletions : [];
  const entryKey = `lot-${entry.id}`;

  return depletions
    .filter((d) => d?.type === "SPEND" || d?.type === "EXPIRE")
    .map((d) => ({
      key: String(d.id),
      tooltipId: `tooltip-${entryKey}-depletion-${d.id}`,
      createdAt: d.createdAt,
      orderId: d.orderId,
      label: `${formatLedgerType(d.type)} ${Math.abs(d.pointsDelta)} points`,
    }));
}

function renderLotTooltipContent(sourceLot) {
  if (!sourceLot) return "—";

  if (sourceLot.type === "EARN") {
    const numericOrderId = getTrailingNumericId(sourceLot.orderId);

    return (
      <>
        <s-paragraph>{formatTimestampLong(sourceLot.createdAt)}</s-paragraph>
        <s-paragraph>Order ID: {numericOrderId ?? "—"}</s-paragraph>
        <s-paragraph>Points earned: {sourceLot.pointsDelta}</s-paragraph>
        <s-paragraph>Points remaining: {formatNumber(sourceLot.remainingPoints)}</s-paragraph>
        <s-paragraph>Expires: {formatDateMMDDYYYY(sourceLot.expiresAt)}</s-paragraph>
      </>
    );
  }

  if (sourceLot.type === "ADJUST" && sourceLot.pointsDelta > 0) {
    return (
      <>
        <s-text>Timestamp: {formatTimestampLong(sourceLot.createdAt)}</s-text>
        <s-text>Points added: {sourceLot.pointsDelta}</s-text>
        <s-text>Points remaining: {formatNumber(sourceLot.remainingPoints)}</s-text>
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
