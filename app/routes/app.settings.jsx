import { useFetcher, useLoaderData } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const config = await db.rewardsConfig.findUnique({ where: { id: 1 } });

  return {
    config: {
      pointsPerDollar: config?.pointsPerDollar ?? 20,
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
  await authenticate.admin(request);
  const formData = await request.formData();

  const pointsPerDollar = parseOptionalInt(formData.get("pointsPerDollar"));
  const pointsExpirationDays = parseOptionalInt(
    formData.get("pointsExpirationDays"),
  );
  const isEnabled = formData.get("isEnabled") === "on";

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

  await db.rewardsConfig.upsert({
    where: { id: 1 },
    update: {
      pointsPerDollar,
      pointsExpirationDays,
      isEnabled,
    },
    create: {
      id: 1,
      pointsPerDollar,
      pointsExpirationDays,
      isEnabled,
    },
  });

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
            <s-text-field
              label="Points per dollar"
              name="pointsPerDollar"
              value={pointsPerDollar}
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
            <s-switch
              label="Enable rewards"
              name="isEnabled"
              checked={isEnabled}
              onChange={(event) => setIsEnabled(event.currentTarget.checked)}
            />
          </s-stack>
        </form>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
