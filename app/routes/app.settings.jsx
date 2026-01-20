import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const parseOptionalInt = (value) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const config = await db.config.findUnique({ where: { id: 1 } });

  const centsToOneUsd = config?.centsToOneUsd ?? 0;
  const dollarsToOneUsd = centsToOneUsd > 0 ? String(Math.floor(centsToOneUsd / 100)) : "";

  return {
    config: {
      dollarsToOneUsd,
      expirationDays: config?.expirationDays ?? "",
      isActive: config?.isActive ?? true,
    },
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = String(formData.get("intent") ?? "save_config");
  if (intent !== "save_config") {
    return { ok: false, errors: { form: "Unsupported action" } };
  }

  const dollarsField = String(formData.get("dollarsToOneUsd") ?? "").trim();
  const expirationDays = parseOptionalInt(formData.get("expirationDays"));
  const isActive = String(formData.get("isActive") ?? "active") === "active";

  const configuredCentsToOneUsd = dollarsField !== "";
  const dollarsToOneUsd = configuredCentsToOneUsd ? parseOptionalInt(dollarsField) : null;

  const errors = {};

  if (configuredCentsToOneUsd && (dollarsToOneUsd == null || dollarsToOneUsd < 0)) {
    errors.dollarsToOneUsd = "Must be a whole number (0 or higher)";
  }

  if (expirationDays != null && (expirationDays < 0 || !Number.isInteger(expirationDays))) {
    errors.expirationDays = "Must be a whole number (0 or higher)";
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const storedCentsToOneUsd = configuredCentsToOneUsd ? (dollarsToOneUsd ?? 0) * 100 : 0;
  const storedExpirationDays = configuredCentsToOneUsd ? expirationDays : null;

  await db.config.upsert({
    where: { id: 1 },
    update: {
      centsToOneUsd: storedCentsToOneUsd,
      expirationDays: storedExpirationDays,
      isActive,
    },
    create: {
      id: 1,
      centsToOneUsd: storedCentsToOneUsd,
      expirationDays: storedExpirationDays,
      isActive,
    },
  });

  try {
    const shopIdResponse = await admin.graphql(`
      query ShopId {
        shop { id }
      }
    `);
    const shopIdJson = await shopIdResponse.json();
    const ownerId = shopIdJson?.data?.shop?.id ?? null;

    if (ownerId) {
      const mutation = `
        mutation SetRewardsConfig($metafields: [MetafieldsSetInput!]!) {
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
              key: "cents_to_one_usd",
              type: "number_integer",
              value: String(storedCentsToOneUsd),
            },
            {
              ownerId,
              namespace: "rewards",
              key: "expiration_days",
              type: "number_integer",
              value: String(storedExpirationDays ?? 0),
            },
            {
              ownerId,
              namespace: "rewards",
              key: "is_active",
              type: "boolean",
              value: isActive ? "true" : "false",
            },
          ],
        },
      });

      const json = await response.json();
      const userErrors = json?.data?.metafieldsSet?.userErrors ?? [];
      if (userErrors.length > 0) {
        console.error("Failed to set rewards config metafields:", userErrors);
      }
    }
  } catch (error) {
    console.error("Error setting rewards config metafields:", error);
  }

  return { ok: true, savedAt: Date.now() };
};

export default function SettingsPage() {
  const fetcher = useFetcher();
  const { config } = useLoaderData();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();

  const initialValues = useMemo(
    () => ({
      dollarsToOneUsd: String(config.dollarsToOneUsd ?? ""),
      expirationDays: config.expirationDays === "" ? "" : String(config.expirationDays ?? ""),
      isActive: Boolean(config.isActive),
    }),
    [config.dollarsToOneUsd, config.expirationDays, config.isActive],
  );

  const originalValuesRef = useRef(initialValues);
  const [dollarsToOneUsd, setDollarsToOneUsd] = useState(initialValues.dollarsToOneUsd);
  const [expirationDays, setExpirationDays] = useState(initialValues.expirationDays);
  const [status, setStatus] = useState(initialValues.isActive ? "active" : "inactive");

  const errors = fetcher.data?.ok === false ? fetcher.data.errors ?? {} : {};

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    if (!fetcher.data?.ok || !fetcher.data?.savedAt) return;

    shopify?.toast?.show("Settings updated");
    revalidator.revalidate();

    originalValuesRef.current = {
      dollarsToOneUsd,
      expirationDays,
      isActive: status === "active",
    };
  }, [dollarsToOneUsd, expirationDays, fetcher.data, fetcher.state, revalidator, shopify, status]);

  const handleSave = (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    data.set("intent", "save_config");
    fetcher.submit(data, { method: "post" });
  };

  const handleDiscard = () => {
    const original = originalValuesRef.current;
    setDollarsToOneUsd(original.dollarsToOneUsd);
    setExpirationDays(original.expirationDays);
    setStatus(original.isActive ? "active" : "inactive");
  };

  return (
    <s-page heading="Settings" inlineSize="small">
      {!(config?.dollarsToOneUsd && String(config.dollarsToOneUsd).trim()) ? (
        <s-banner tone="critical">
          You need to configure how many dollars are needed to get $1 in rewards.
        </s-banner>
      ) : null}
      <s-section>
        <form data-save-bar onSubmit={handleSave} onReset={handleDiscard}>
          <input type="hidden" name="intent" value="save_config" />
          <s-stack direction="block" gap="base">
            <s-heading>Settings</s-heading>

            <s-text-field
              label="Dollars needed to get one $1 rewards"
              name="dollarsToOneUsd"
              value={dollarsToOneUsd}
              onChange={(event) => setDollarsToOneUsd(event.currentTarget.value)}
              error={errors.dollarsToOneUsd}
            />

            <s-text-field
              label="Expiration (days)"
              name="expirationDays"
              value={expirationDays}
              placeholder="Leave empty for no expiration"
              onChange={(event) => setExpirationDays(event.currentTarget.value)}
              error={errors.expirationDays}
            />

            <s-select
              label="Status"
              name="isActive"
              value={status}
              onChange={(event) => setStatus(event.currentTarget.value)}
            >
              <s-option value="active">Active — Customers can earn and spend rewards</s-option>
              <s-option value="inactive">Inactive — Pause all earning and spending</s-option>
            </s-select>
          </s-stack>
        </form>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
