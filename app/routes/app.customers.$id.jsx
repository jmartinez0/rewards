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

const setCustomerRewardsMetafields = async ({
  admin,
  shopifyCustomerId,
  currentRewardsCents,
  lifetimeRewardsCents,
}) => {
  const ownerId = getCustomerGid(shopifyCustomerId);
  if (!ownerId) return;

  try {
    const mutation = `
      mutation SetCustomerRewards($metafields: [MetafieldsSetInput!]!) {
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
      console.error("Failed to set customer rewards metafields", {
        ownerId,
        userErrors,
      });
    }
  } catch (error) {
    console.error("Error setting customer rewards metafields", {
      ownerId,
      error: error?.message ?? String(error),
    });
  }
};

const parseDollarsToCents = (value) => {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;

  const match = normalized.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;

  const dollars = Number(match[1] || "0");
  const cents = Number(((match[2] || "") + "00").slice(0, 2));
  if (!Number.isFinite(dollars) || !Number.isFinite(cents)) return null;

  return dollars * 100 + cents;
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
  const { admin, session } = await authenticate.admin(request);

  const id = Number.parseInt(params.id, 10);
  if (Number.isNaN(id)) {
    throw new Response("Invalid customer id", { status: 400 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  if (intent !== "adjust_rewards") {
    return { ok: false, errors: { form: "Unsupported action" } };
  }

  const adjustmentType = String(formData.get("adjustmentType") ?? "");
  const adjustByRaw = String(formData.get("adjustBy") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

  const errors = {};

  const adjustByCents = parseDollarsToCents(adjustByRaw);
  if (!adjustByRaw || adjustByCents == null) {
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
    if (!errors.adjustBy && adjustByCents <= 0) {
      errors.adjustBy = "Must be a positive number";
    }
  } else if (adjustmentType === "decrease") {
    if (
      !errors.adjustBy &&
      (adjustByCents < 1 || adjustByCents > customer.currentRewardsCents)
    ) {
      errors.adjustBy = `Must be between $0.01-$${formatDollars(customer.currentRewardsCents)}`;
    }
  } else {
    errors.adjustmentType = "Select increase or decrease";
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const config = await db.config.findUnique({ where: { id: 1 } });
  const now = new Date();
  const expiresAt =
    adjustmentType === "increase" && config?.expirationDays
      ? new Date(
        now.getTime() + config.expirationDays * 24 * 60 * 60 * 1000,
      )
      : null;

  const rewardsDeltaCents =
    adjustmentType === "decrease" ? -adjustByCents : adjustByCents;
  const adjustedByEmail = session?.email ? String(session.email).trim() : null;

  await db.$transaction(async (tx) => {
    if (rewardsDeltaCents > 0) {
      await tx.ledgerEntry.create({
        data: {
          customerId: customer.id,
          type: "ADJUST",
          rewardsDeltaCents,
          remainingRewardsCents: rewardsDeltaCents,
          expiresAt,
          adjustedByEmail,
          notes: reason,
          createdAt: now,
        },
      });
    } else {
      const adjustmentGroupId = crypto?.randomUUID?.() ?? String(Date.now());

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
                { expiresAt: { gt: now } },
              ],
            },
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          remainingRewardsCents: true,
        },
      });

      const totalAvailable = lots.reduce((sum, lot) => {
        const lotRemaining =
          typeof lot.remainingRewardsCents === "number"
            ? lot.remainingRewardsCents
            : 0;
        return sum + Math.max(0, lotRemaining);
      }, 0);

      if (totalAvailable <= 0 || Math.abs(rewardsDeltaCents) > totalAvailable) {
        throw new Response("Not enough available rewards to decrease.", { status: 400 });
      }

      let remainingToRemove = Math.abs(rewardsDeltaCents);

      for (const lot of lots) {
        if (remainingToRemove <= 0) break;
        const lotRemaining =
          typeof lot.remainingRewardsCents === "number"
            ? lot.remainingRewardsCents
            : 0;
        if (lotRemaining <= 0) continue;

        const take = Math.min(lotRemaining, remainingToRemove);
        remainingToRemove -= take;

        await tx.ledgerEntry.update({
          where: { id: lot.id },
          data: { remainingRewardsCents: Math.max(0, lotRemaining - take) },
        });

        await tx.ledgerEntry.create({
          data: {
            customerId: customer.id,
            type: "ADJUST",
            rewardsDeltaCents: -take,
            remainingRewardsCents: null,
            expiresAt: null,
            adjustedByEmail,
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
        currentRewardsCents:
          rewardsDeltaCents > 0
            ? { increment: rewardsDeltaCents }
            : { decrement: Math.abs(rewardsDeltaCents) },
        ...(rewardsDeltaCents > 0
          ? { lifetimeRewardsCents: { increment: rewardsDeltaCents } }
          : {}),
      },
    });
  });

  const updatedCustomer = await db.customer.findUnique({
    where: { id: customer.id },
    select: { currentRewardsCents: true, lifetimeRewardsCents: true, shopifyCustomerId: true },
  });

  if (updatedCustomer) {
    await setCustomerRewardsMetafields({
      admin,
      shopifyCustomerId: updatedCustomer.shopifyCustomerId,
      currentRewardsCents: updatedCustomer.currentRewardsCents,
      lifetimeRewardsCents: updatedCustomer.lifetimeRewardsCents,
    });
  }

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
    currentRewardsCents: customer.currentRewardsCents,
  });
  const reasonError = getReasonError(adjustReason);
  const serverAdjustByError = fetcher.data?.errors?.adjustBy;
  const serverReasonError = fetcher.data?.errors?.reason;
  const canSaveAdjustment =
    !adjustByError && !reasonError && fetcher.state === "idle";
  const afterAdjustmentRewardsCents = getAfterAdjustmentRewardsCents({
    adjustmentType,
    currentRewardsCents: customer.currentRewardsCents,
    adjustBy,
  });

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    if (!fetcher.data?.ok || !fetcher.data?.savedAt) return;
    if (fetcher.data.savedAt === lastAdjustmentSavedAtRef.current) return;

    lastAdjustmentSavedAtRef.current = fetcher.data.savedAt;

    const modalEl = document.getElementById("adjustRewards");
    if (modalEl && typeof modalEl.hideOverlay === "function") {
      modalEl.hideOverlay();
    }

    setAdjustmentType("increase");
    setAdjustBy("");
    setAdjustReason("");
    setAdjustTouched(false);

    if (shopify?.toast) {
      shopify.toast.show("Rewards adjusted");
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
              <s-heading>Rewards</s-heading>
              <s-text>Current rewards: {formatMoney(customer.currentRewardsCents)}</s-text>
              <s-text>Lifetime rewards: {formatMoney(customer.lifetimeRewardsCents)}</s-text>
              <s-button commandFor="adjustRewards">
                Adjust rewards
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
                <s-table-header>Rewards</s-table-header>
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
                        <s-table-cell>{formatSignedMoney(entry.rewardsDeltaCents)}</s-table-cell>
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
        const rewardsLabel = getRewardsLabel(entry.type, entry.rewardsDeltaCents);
        const numericOrderId = getTrailingNumericId(entry.orderId);
        const orderAdminHref =
          numericOrderId && storeSlug
            ? `https://admin.shopify.com/store/${storeSlug}/orders/${numericOrderId}`
            : undefined;
        const rewardsSpentFromLots =
          entry.type === "SPEND" ? getRewardsSpentFromLots(row) : null;
        const rewardsRemovedFromLots =
          entry.type === "ADJUST" && entry.rewardsDeltaCents < 0
            ? getRewardsRemovedFromLots(row)
            : null;
        const rewardsDepletedBy =
          row.kind === "single" ? getRewardsDepletedBy(entry) : null;

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
              {rewardsLabel ? (
                <s-text>{rewardsLabel}: {formatMoney(Math.abs(entry.rewardsDeltaCents))}</s-text>
              ) : null}
              {rewardsRemovedFromLots && rewardsRemovedFromLots.length ? (
                <s-unordered-list>
                  {rewardsRemovedFromLots.map((lot) => (
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
              {rewardsSpentFromLots ? (
                <s-stack direction="block" gap="small-200">
                  <s-text>Rewards spent from:</s-text>
                  {rewardsSpentFromLots.length ? (
                    <s-unordered-list>
                      {rewardsSpentFromLots.map((lot) => (
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
                  Rewards remaining: {formatMoney(entry.remainingRewardsCents)}
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
                  const adjustedBy =
                    row.kind === "adjust_group"
                      ? row.entries?.find((rowEntry) => String(rowEntry?.adjustedByEmail ?? "").trim())
                        ?.adjustedByEmail
                      : entry.adjustedByEmail;
                  const reason = stripRefundMarker(rawNotes?.trim());
                  const refundReasonMatches =
                    reason?.startsWith("Order ") &&
                    (reason.includes(" was refunded") ||
                      reason.includes(" was partially refunded"));
                  const reasonOrderAdminHref =
                    numericOrderId && storeSlug
                      ? `https://admin.shopify.com/store/${storeSlug}/orders/${numericOrderId}`
                      : undefined;

                  if (refundReasonMatches && numericOrderId) {
                    return (
                      <s-stack direction="block" gap="small-200">
                        <s-text>
                          Reason: Order{" "}
                          {reasonOrderAdminHref ? (
                            <s-link
                              href={reasonOrderAdminHref}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {numericOrderId}
                            </s-link>
                          ) : (
                            numericOrderId
                          )}{reason.includes("partially") ? " was partially refunded" : " was refunded"}
                        </s-text>
                        {adjustedBy ? <s-text>Adjusted by: {adjustedBy}</s-text> : null}
                      </s-stack>
                    );
                  }

                  return (
                    <s-stack direction="block" gap="small-200">
                      <s-text>Reason: {reason || "—"}</s-text>
                      {adjustedBy ? <s-text>Adjusted by: {adjustedBy}</s-text> : null}
                    </s-stack>
                  );
                })()
              ) : null}
              {rewardsDepletedBy && rewardsDepletedBy.length ? (
                <s-stack direction="block" gap="small-200">
                  <s-text>Rewards depleted by:</s-text>
                  <s-unordered-list>
                    {rewardsDepletedBy.map((depletion) => (
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
                              Reason: {stripRefundMarker(depletion.notes?.trim() || "") || "—"}
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
        id="adjustRewards"
        heading="Adjust rewards"
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
            prefix="$"
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
            <s-text>Current rewards: {formatMoney(customer.currentRewardsCents)}</s-text>
            <s-text>After adjustment: {formatMoney(afterAdjustmentRewardsCents)}</s-text>
          </s-stack>
        </s-stack>

        <s-button slot="secondary-actions" commandFor="adjustRewards" command="--hide">
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
            formData.set("intent", "adjust_rewards");
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

function stripRefundMarker(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\s*\[refund:[^\]]+\]\s*$/i, "").trim();
}

function getAdjustByError({ adjustmentType, adjustBy, currentRewardsCents }) {
  const rawValue = adjustBy.trim();
  const amountCents = parseDollarsToCents(rawValue);
  if (amountCents == null) return "Must be a number";

  if (adjustmentType === "increase") {
    if (amountCents <= 0) return "Must be a positive number";
    return null;
  }

  if (adjustmentType === "decrease") {
    if (amountCents < 1 || amountCents > currentRewardsCents) {
      return `Must be between $0.01-${formatMoney(currentRewardsCents)}`;
    }
    return null;
  }

  return "Must be a number";
}

function getReasonError(reason) {
  if (!reason.trim()) return "Reason is required";
  return null;
}

function getAfterAdjustmentRewardsCents({ adjustmentType, currentRewardsCents, adjustBy }) {
  const amountCents = parseDollarsToCents(adjustBy.trim());
  if (amountCents == null || amountCents < 0) return currentRewardsCents;

  if (adjustmentType === "decrease") {
    return currentRewardsCents - amountCents;
  }

  return currentRewardsCents + amountCents;
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

function formatDollars(valueCents) {
  if (typeof valueCents !== "number" || Number.isNaN(valueCents)) return "0.00";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(valueCents / 100);
}

function formatMoney(valueCents) {
  if (typeof valueCents !== "number" || Number.isNaN(valueCents)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(valueCents / 100);
}

function formatSignedMoney(valueCents) {
  if (typeof valueCents !== "number" || Number.isNaN(valueCents)) return "-";
  if (valueCents > 0) return `+${formatMoney(valueCents)}`;
  return formatMoney(valueCents);
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

function getRewardsLabel(type, rewardsDeltaCents) {
  if (type === "EARN") return "Rewards earned";
  if (type === "SPEND") return "Rewards spent";

  if (type === "ADJUST") {
    if (rewardsDeltaCents > 0) return "Rewards added";
    if (rewardsDeltaCents < 0) return "Rewards removed";
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
    if (entry.type !== "ADJUST" || entry.rewardsDeltaCents >= 0) return;
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

      const rewardsDeltaCents = group.entries.reduce(
        (sum, spendEntry) => sum + spendEntry.rewardsDeltaCents,
        0
      );

      rows.push({
        kind: "spend_group",
        id: `spend:${entry.orderId}`,
        type: "SPEND",
        rewardsDeltaCents,
        createdAt: entry.createdAt,
        orderId: entry.orderId,
        entries: group.entries,
      });
      return;
    }

    if (entry.type === "ADJUST" && entry.rewardsDeltaCents < 0 && entry.adjustmentGroupId) {
      const group = adjustGroups.get(entry.adjustmentGroupId);
      if (!group || group.firstIndex !== index) return;

      const rewardsDeltaCents = group.entries.reduce(
        (sum, adjustEntry) => sum + adjustEntry.rewardsDeltaCents,
        0
      );

      rows.push({
        kind: "adjust_group",
        id: `adjust:${entry.adjustmentGroupId}`,
        type: "ADJUST",
        rewardsDeltaCents,
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

function getRewardsSpentFromLots(row) {
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

    existing.spent += Math.abs(spendEntry?.rewardsDeltaCents ?? 0);
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
        `${formatMoney(item.spent)}`,
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

function getRewardsRemovedFromLots(row) {
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
    if (adjustEntry?.type !== "ADJUST" || !(adjustEntry?.rewardsDeltaCents < 0)) return;
    const lotId = adjustEntry?.sourceLotId;
    if (!lotId) return;

    const existing = byLotId.get(lotId) ?? {
      lotId,
      sourceLot: adjustEntry?.sourceLot,
      removed: 0,
    };

    existing.removed += Math.abs(adjustEntry?.rewardsDeltaCents ?? 0);
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
        `${formatMoney(item.removed)}`,
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

function getRewardsDepletedBy(entry) {
  const isSourceLot =
    entry?.type === "EARN" ||
    (entry?.type === "ADJUST" && entry?.rewardsDeltaCents > 0);
  if (!isSourceLot) return null;

  const depletions = Array.isArray(entry.depletions) ? entry.depletions : [];
  const entryKey = `lot-${entry.id}`;

  return depletions
    .filter((d) => {
      if (d?.type === "SPEND" || d?.type === "EXPIRE") return true;
      return d?.type === "ADJUST" && d?.rewardsDeltaCents < 0;
    })
    .map((d) => {
      const notes = String(d?.notes ?? "").trim();
      const isRefund =
        notes.startsWith("Order ") &&
        (notes.includes(" was refunded") || notes.includes(" was partially refunded"));

      return {
        key: String(d.id),
        tooltipId: `tooltip-${entryKey}-depletion-${d.id}`,
        createdAt: d.createdAt,
        orderId: d.orderId,
        notes,
        label: `${isRefund ? "Refund" : formatLedgerType(d.type)} ${formatMoney(Math.abs(d.rewardsDeltaCents))}`,
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
        <s-paragraph>Rewards earned: {formatMoney(sourceLot.rewardsDeltaCents)}</s-paragraph>
        <s-paragraph>Rewards remaining: {formatMoney(sourceLot.remainingRewardsCents)}</s-paragraph>
        <s-paragraph>Expires: {formatDateMMDDYYYY(sourceLot.expiresAt)}</s-paragraph>
      </>
    );
  }

  if (sourceLot.type === "ADJUST" && sourceLot.rewardsDeltaCents > 0) {
    return (
      <>
        <s-paragraph>{formatTimestampLong(sourceLot.createdAt)}</s-paragraph>
        <s-paragraph>Rewards added: {formatMoney(sourceLot.rewardsDeltaCents)}</s-paragraph>
        <s-paragraph>Rewards remaining: {formatMoney(sourceLot.remainingRewardsCents)}</s-paragraph>
      </>
    );
  }

  return (
    <>
      <s-text>{formatTimestampLong(sourceLot.createdAt)}</s-text>
      <s-text>Type: {formatLedgerType(sourceLot.type)}</s-text>
      <s-text>Rewards: {formatMoney(sourceLot.rewardsDeltaCents)}</s-text>
      <s-text>Rewards remaining: {formatMoney(sourceLot.remainingRewardsCents)}</s-text>
    </>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
