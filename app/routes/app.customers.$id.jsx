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

  const ledgerEntries = Array.isArray(customer.rewardsLedgerEntries)
    ? customer.rewardsLedgerEntries
    : [];

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

        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-section>
            <s-stack direction="block" gap="base">
              <s-heading>Customer</s-heading>

              <s-text>
                <s-text type="strong">Name:</s-text> {customer.name ?? "—"}
              </s-text>

              <s-text>
                <s-text type="strong">Email:</s-text> {customer.email}
              </s-text>

              <s-text>
                <s-text type="strong">Customer ID:</s-text>{" "}
                {numericCustomerId && customerAdminHref ? (
                  <s-link
                    href={customerAdminHref}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {numericCustomerId}
                  </s-link>
                ) : (
                  "N/A (Guest account)"
                )}
              </s-text>
            </s-stack>
          </s-section>

          <s-section>
            <s-stack direction="block" gap="base">
              <s-heading>Points</s-heading>
              <s-text>
                <s-text type="strong">Current points:</s-text>{" "}
                {customer.currentPoints}
              </s-text>

              <s-text>
                <s-text type="strong">Lifetime points:</s-text>{" "}
                {customer.lifetimePoints}
              </s-text>

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
                {ledgerEntries.length ? (
                  ledgerEntries.map((entry, index) => {
                    const num = index + 1;
                    const rowId = `row-${num}`;
                    const modalId = `modal-${num}`;

                    return (
                      <s-table-row key={entry.id} clickDelegate={rowId}>
                        <s-table-cell>
                          <s-box padding="none small-400">
                            {formatDateMMDDYYYY(entry.createdAt)}
                          </s-box>
                        </s-table-cell>
                        <s-table-cell>{formatLedgerType(entry.type)}</s-table-cell>
                        <s-table-cell>{formatPointsDelta(entry.pointsDelta)}</s-table-cell>
                        <s-link id={rowId} commandFor={modalId} />
                      </s-table-row>
                    );
                  })
                ) : (
                  <s-table-row>
                    <s-table-cell>
                      <s-box padding="none small-400">—</s-box>
                    </s-table-cell>
                    <s-table-cell>—</s-table-cell>
                    <s-table-cell>—</s-table-cell>
                  </s-table-row>
                )}

              </s-table-body>
            </s-table>
          </s-stack>
        </s-section>
      </s-stack>
      {ledgerEntries.map((entry, index) => {
        const num = index + 1;
        const modalId = `modal-${num}`;
        const pointsLabel = getPointsLabel(entry);

        return (
          <s-modal
            key={modalId}
            id={modalId}
            heading={`Points event on ${formatDateMMDDYYYY(entry.createdAt)}`}
          >
            <s-stack direction="block" gap="small">
              <s-text>
                <s-text type="strong">Timestamp:</s-text>{" "}
                {formatTimestampLong(entry.createdAt)}
              </s-text>
              {pointsLabel ? (
                <s-text>
                  <s-text type="strong">{pointsLabel}:</s-text>{" "}
                  {formatPointsAmount(entry.pointsDelta)}
                </s-text>
              ) : null}
              {entry.type === "EARN" ? (
                <s-text>
                  <s-text type="strong">Points remaining:</s-text>{" "}
                  {typeof entry.remainingPoints === "number"
                    ? entry.remainingPoints
                    : "—"}
                </s-text>
              ) : null}
              {entry.type === "EARN" ? (
                <s-text>
                  <s-text type="strong">Expires:</s-text>{" "}
                  {entry.expiresAt ? formatDateMMDDYYYY(entry.expiresAt) : "—"}
                </s-text>
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
          >
            <s-option value="increase">
              Increase
            </s-option>
            <s-option value="decrease">
              Decrease
            </s-option>
          </s-select>

          <s-text-field
            label="Increase by"
            name="pointsExpirationDays"
          />

          <s-text-field
            label="Reason"
            name="pointsExpirationDays"
          />

          <s-stack gap="small">
            <s-text>Current points: {customer.currentPoints} points</s-text>
            <s-text>After adjustment: {customer.currentPoints} points</s-text>
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

function formatDateMMDDYYYY(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  }).format(date);
}

function formatTimestampLong(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

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

function formatPointsDelta(pointsDelta) {
  if (typeof pointsDelta !== "number" || Number.isNaN(pointsDelta)) return "—";
  if (pointsDelta > 0) return `+${pointsDelta}`;
  return String(pointsDelta);
}

function formatPointsAmount(pointsDelta) {
  if (typeof pointsDelta !== "number" || Number.isNaN(pointsDelta)) return "—";
  return String(Math.abs(pointsDelta));
}

function formatLedgerType(type) {
  if (typeof type !== "string" || !type) return "—";
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

function getPointsLabel(entry) {
  if (!entry) return null;

  if (entry.type === "EARN") return "Points earned";
  if (entry.type === "SPEND") return "Points spent";

  if (entry.type === "ADJUST") {
    if (entry.pointsDelta > 0) return "Points added";
    if (entry.pointsDelta < 0) return "Points removed";
  }

  return null;
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
