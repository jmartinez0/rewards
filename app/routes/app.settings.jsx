import { useFetcher, useLoaderData } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const config = await db.config.findUnique({ where: { shop } });

  return {
    config: {
      pointsPerDollar: config?.pointsPerDollar ?? "",
      pointsExpirationDays: config?.pointsExpirationDays ?? "",
      isEnabled: config?.isEnabled ?? true,
    },
  };
};

const parseOptionalInt = (value) => {
  if (value == null || value === "") {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? null : parsed;
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();

  const pointsPerDollar = parseOptionalInt(formData.get("pointsPerDollar"));
  const pointsExpirationDays = parseOptionalInt(
    formData.get("pointsExpirationDays"),
  );
  const isEnabled = formData.get("isEnabled") === "active";

  const errors = {};
  if (pointsPerDollar == null || pointsPerDollar < 0) {
    errors.pointsPerDollar = "Enter a valid number (0 or higher).";
  }

  if (
    pointsExpirationDays != null &&
    (pointsExpirationDays < 0 || !Number.isInteger(pointsExpirationDays))
  ) {
    errors.pointsExpirationDays = "Enter a valid number of days.";
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  await db.config.upsert({
    where: { shop },
    update: {
      pointsPerDollar,
      pointsExpirationDays,
      isEnabled,
    },
    create: {
      shop,
      pointsPerDollar,
      pointsExpirationDays,
      isEnabled,
    },
  });

  try {
    const shopIdResponse = await admin.graphql(`
      query ShopId {
        shop {
          id
        }
      }
    `);
    const shopIdJson = await shopIdResponse.json();
    const ownerId = shopIdJson?.data?.shop?.id;

    const mutation = `
      mutation {
        metafieldsSet(
          metafields: [
            {
              ownerId: "${ownerId}"
              namespace: "rewards"
              key: "points_per_dollar"
              type: "number_integer"
              value: "${pointsPerDollar}"
            }
          ]
        ) {
          metafields {
            id
            namespace
            key
            type
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const metafieldResponse = await admin.graphql(mutation);
    const metafieldJson = await metafieldResponse.json();
    const userErrors = metafieldJson?.data?.metafieldsSet?.userErrors ?? [];

    if (userErrors.length > 0) {
      console.error("Failed to set rewards.points_per_dollar: ", userErrors);
    }
  } catch (error) {
    console.error("Error setting rewards.points_per_dollar: ", error);
  }

  return { ok: true, savedAt: Date.now() };
};

export default function SettingsPage() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const { config } = useLoaderData();
  const initialValues = useMemo(
    () => ({
      pointsPerDollar: String(config.pointsPerDollar),
      pointsExpirationDays:
        config.pointsExpirationDays === ""
          ? ""
          : String(config.pointsExpirationDays),
      isEnabled: Boolean(config.isEnabled),
    }),
    [
      config.isEnabled,
      config.pointsExpirationDays,
      config.pointsPerDollar,
    ],
  );
  const originalValuesRef = useRef(initialValues);
  const [pointsPerDollar, setPointsPerDollar] = useState(
    initialValues.pointsPerDollar,
  );
  const [pointsExpirationDays, setPointsExpirationDays] = useState(
    initialValues.pointsExpirationDays,
  );
  const [isEnabled, setIsEnabled] = useState(initialValues.isEnabled);

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    if (!fetcher.data?.ok || !fetcher.data?.savedAt) return;
    if (fetcher.data.savedAt === originalValuesRef.current.savedAt) return;
    originalValuesRef.current = {
      pointsPerDollar,
      pointsExpirationDays,
      isEnabled,
      savedAt: fetcher.data.savedAt,
    };
    if (!shopify?.toast) return;
    shopify.toast.show("Settings saved");
  }, [
    fetcher.data,
    fetcher.state,
    isEnabled,
    pointsExpirationDays,
    pointsPerDollar,
    shopify,
  ]);

  const errors = useMemo(
    () => ({
      pointsPerDollar: fetcher.data?.errors?.pointsPerDollar ?? "",
      pointsExpirationDays: fetcher.data?.errors?.pointsExpirationDays ?? "",
    }),
    [fetcher.data],
  );

  const handleSave = (event) => {
    event.preventDefault();
    fetcher.submit(event.currentTarget, { method: "post" });
  };

  const handleDiscard = (event) => {
    event.preventDefault();
    setPointsPerDollar(originalValuesRef.current.pointsPerDollar);
    setPointsExpirationDays(originalValuesRef.current.pointsExpirationDays);
    setIsEnabled(originalValuesRef.current.isEnabled);
  };

  return (
    <s-page heading="Settings" inlineSize="small">
      <s-section>
        <form data-save-bar onSubmit={handleSave} onReset={handleDiscard}>
          <s-stack direction="block" gap="base">
            <s-heading>Configuration</s-heading>
            <s-text-field
              label="Points per dollar"
              name="pointsPerDollar"
              value={pointsPerDollar}
              placeholder="Enter a whole number"
              error={errors.pointsPerDollar}
              onChange={(event) => setPointsPerDollar(event.currentTarget.value)}
            />
            <s-text-field
              label="Expiration (days)"
              name="pointsExpirationDays"
              value={pointsExpirationDays}
              placeholder="Leave blank for no expiration"
              error={errors.pointsExpirationDays}
              onChange={(event) =>
                setPointsExpirationDays(event.currentTarget.value)
              }
            />
            <s-select
              label="Status"
              name="isEnabled"
              value={isEnabled ? "active" : "inactive"}
              onChange={(event) =>
                setIsEnabled(event.currentTarget.value === "active")
              }
            >
              <s-option value="active">
                Active — Customers can earn and spend points
              </s-option>
              <s-option value="inactive">
                Inactive — Pause all earning and spending
              </s-option>
            </s-select>
          </s-stack>
        </form>
      </s-section>

      <s-section>
        <s-stack gap="base">


          <s-heading>Discount rules</s-heading>
          <s-button commandFor="addNewRule">Add new discount rule</s-button>
        </s-stack>
        <s-modal id="addNewRule" heading="Add new discount rule">
          <s-stack gap="base">
            <s-text-field
              label="Points required to get discount"
              name="pointsForDiscount"
            ></s-text-field>

            <s-text-field
              label="Percentage off order"
              name="percentOff"
            ></s-text-field></s-stack>

          <s-button slot="secondary-actions" commandFor="adjustPoints" command="--hide">
            Close
          </s-button>
          <s-button
            slot="primary-action"
            variant="primary"
          >
            Save
          </s-button>
        </s-modal>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
