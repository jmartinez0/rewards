import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const [config, discountRuleCount, discountRules] = await Promise.all([
    db.config.findFirst({ orderBy: { id: "asc" } }),
    db.discountRule.count(),
    db.discountRule.findMany({
      orderBy: { points: "asc" },
    }),
  ]);

  return {
    config: {
      pointsPerDollar:
        config?.configuredPointsPerDollar === false
          ? ""
          : config?.pointsPerDollar ?? "",
      pointsExpirationDays: config?.pointsExpirationDays ?? "",
      isActive: config?.isActive ?? true,
      configuredPointsPerDollar: Boolean(config?.configuredPointsPerDollar),
    },
    hasDiscountRule: discountRuleCount > 0,
    discountRules,
  };
};

const parseOptionalInt = (value) => {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (!/^-?\d+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "save_config");

  const getDiscountRulesPayload = (rules) => {
    return {
      discountRules: rules.map((rule) => ({
        points: rule.points,
        percentOff: rule.percentOff,
        isActive: Boolean(rule.isActive),
      })),
    };
  };

  const getShopOwnerId = async () => {
    const shopIdResponse = await admin.graphql(`
      query ShopId {
        shop {
          id
        }
      }
    `);
    const shopIdJson = await shopIdResponse.json();
    return shopIdJson?.data?.shop?.id ?? null;
  };

  const setDiscountMetafields = async (rules) => {
    const ownerId = await getShopOwnerId();
    if (!ownerId) return;

    const minPoints = rules
      .filter((rule) => rule.isActive)
      .reduce(
        (min, rule) => (min == null || rule.points < min ? rule.points : min),
        null,
      );

    const mutation = `
      mutation SetDiscountMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors {
            field
            message
          }
        }
      }
    `;

    const discountRulesValue = JSON.stringify(getDiscountRulesPayload(rules));

    const metafieldResponse = await admin.graphql(mutation, {
      variables: {
        metafields: [
          {
            ownerId,
            namespace: "rewards",
            key: "min_points_for_discount",
            type: "number_integer",
            value: String(minPoints ?? 0),
          },
          {
            ownerId,
            namespace: "rewards",
            key: "discount_rules",
            type: "json",
            value: discountRulesValue,
          },
        ],
      },
    });

    const metafieldJson = await metafieldResponse.json();
    const userErrors = metafieldJson?.data?.metafieldsSet?.userErrors ?? [];
    if (userErrors.length > 0) {
      console.error("Failed to set rewards discount metafields: ", userErrors);
    }
  };

  const validateRuleFields = ({ points, percentOff }) => {
    const errors = {};
    if (points == null) {
      errors.points = "Must be a number";
    } else if (!Number.isInteger(points) || points < 0) {
      errors.points = "Must be a whole number (0 or higher).";
    }

    if (percentOff == null) {
      errors.percentOff = "Must be a number";
    } else if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100) {
      errors.percentOff = "Must be between 1-100%.";
    }

    return errors;
  };

  if (intent === "create_discount_rule" || intent === "update_discount_rule") {
    const idRaw = formData.get("id");
    const points = parseOptionalInt(formData.get("points"));
    const percentOff = parseOptionalInt(formData.get("percentOff"));
    const isActive = String(formData.get("status") ?? "active") === "active";

    const errors = validateRuleFields({ points, percentOff });
    if (Object.keys(errors).length > 0) {
      return { ok: false, intent, errors };
    }

    try {
      if (intent === "create_discount_rule") {
        const existing = await db.discountRule.findUnique({
          where: { points },
        });
        if (existing) {
          return {
            ok: false,
            intent,
            errors: { points: "A rule with this points value already " },
          };
        }

        await db.discountRule.create({
          data: {
            points,
            percentOff,
            isActive,
          },
        });
      } else {
        const id = Number.parseInt(String(idRaw ?? ""), 10);
        if (Number.isNaN(id)) {
          return { ok: false, intent, errors: { form: "Invalid rule id" } };
        }

        const existing = await db.discountRule.findUnique({
          where: { points },
        });
        if (existing && existing.id !== id) {
          return {
            ok: false,
            intent,
            errors: { points: "A rule with this points value already exists" },
          };
        }

        const updated = await db.discountRule.updateMany({
          where: { id },
          data: {
            points,
            percentOff,
            isActive,
          },
        });

        if (!updated.count) {
          return { ok: false, intent, errors: { form: "Rule not found" } };
        }
      }
    } catch (error) {
      const message = error?.message ?? String(error);
      if (message.includes("Unique constraint") || message.includes("Unique")) {
        return {
          ok: false,
          intent,
          errors: { points: "A rule with this points value already exists" },
        };
      }
      console.error("Discount rule mutation failed:", error);
      return { ok: false, intent, errors: { form: "Failed to save rule." } };
    }

    const rules = await db.discountRule.findMany({
      orderBy: { points: "asc" },
    });

    const config = await db.config.findFirst({ orderBy: { id: "asc" } });
    if (config) {
      await db.config.update({
        where: { id: config.id },
        data: { configuredDiscountRule: rules.length > 0 },
      });
    } else {
      await db.config.create({
        data: { configuredDiscountRule: rules.length > 0 },
      });
    }

    await setDiscountMetafields(rules);

    return { ok: true, intent, savedAt: Date.now() };
  }

  if (intent === "delete_discount_rule") {
    const id = Number.parseInt(String(formData.get("id") ?? ""), 10);
    if (Number.isNaN(id)) {
      return { ok: false, intent, errors: { form: "Invalid rule id" } };
    }

    await db.discountRule.deleteMany({ where: { id } });

    const rules = await db.discountRule.findMany({
      orderBy: { points: "asc" },
    });

    const config = await db.config.findFirst({ orderBy: { id: "asc" } });
    if (config) {
      await db.config.update({
        where: { id: config.id },
        data: { configuredDiscountRule: rules.length > 0 },
      });
    } else {
      await db.config.create({
        data: { configuredDiscountRule: rules.length > 0 },
      });
    }

    await setDiscountMetafields(rules);

    return { ok: true, intent, savedAt: Date.now() };
  }

  const pointsPerDollarField = String(formData.get("pointsPerDollar") ?? "").trim();
  const pointsPerDollar = parseOptionalInt(pointsPerDollarField);
  const pointsExpirationDays = parseOptionalInt(
    formData.get("pointsExpirationDays"),
  );
  const isActive = formData.get("isActive") === "active";

  const configuredPointsPerDollar = pointsPerDollarField !== "";

  const errors = {};
  if (
    configuredPointsPerDollar &&
    (pointsPerDollar == null || pointsPerDollar < 0)
  ) {
    errors.pointsPerDollar = "Enter a valid number (0 or higher).";
  }

  if (
    pointsExpirationDays != null &&
    (pointsExpirationDays < 0 || !Number.isInteger(pointsExpirationDays))
  ) {
    errors.pointsExpirationDays = "Enter a valid number of days.";
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, intent, errors };
  }

  const storedPointsPerDollar = configuredPointsPerDollar ? pointsPerDollar : 0;
  const storedPointsExpirationDays = configuredPointsPerDollar
    ? pointsExpirationDays
    : null;

  const existingConfig = await db.config.findFirst({ orderBy: { id: "asc" } });
  if (existingConfig) {
    await db.config.update({
      where: { id: existingConfig.id },
      data: {
        pointsPerDollar: storedPointsPerDollar,
        pointsExpirationDays: storedPointsExpirationDays,
        isActive,
        configuredPointsPerDollar,
      },
    });
  } else {
    await db.config.create({
      data: {
        pointsPerDollar: storedPointsPerDollar,
        pointsExpirationDays: storedPointsExpirationDays,
        isActive,
        configuredPointsPerDollar,
      },
    });
  }

  try {
    const expirationDaysForMetafield = String(storedPointsExpirationDays ?? 0);
    const ownerId = await getShopOwnerId();
    if (ownerId) {
      const mutation = `
        mutation {
          metafieldsSet(
            metafields: [
              {
                ownerId: "${ownerId}"
                namespace: "rewards"
                key: "points_per_dollar"
                type: "number_integer"
                value: "${storedPointsPerDollar}"
              }
              {
                ownerId: "${ownerId}"
                namespace: "rewards"
                key: "expiration_days"
                type: "number_integer"
                value: "${expirationDaysForMetafield}"
              }
              {
                ownerId: "${ownerId}"
                namespace: "rewards"
                key: "is_active"
                type: "boolean"
                value: "${isActive ? "true" : "false"}"
              }
            ]
          ) {
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
        console.error("Failed to set rewards config metafields: ", userErrors);
      }
    }
  } catch (error) {
    console.error("Error setting rewards config metafields: ", error);
  }

  return { ok: true, intent, savedAt: Date.now() };
};

export default function SettingsPage() {
  const configFetcher = useFetcher();
  const rulesFetcher = useFetcher();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const { config, hasDiscountRule, discountRules } = useLoaderData();
  const initialValues = useMemo(
    () => ({
      pointsPerDollar: String(config.pointsPerDollar),
      pointsExpirationDays:
        config.pointsExpirationDays === ""
          ? ""
          : String(config.pointsExpirationDays),
      isActive: Boolean(config.isActive),
    }),
    [
      config.isActive,
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
  const [isActive, setIsActive] = useState(initialValues.isActive);
  const [addPoints, setAddPoints] = useState("");
  const [addPercentOff, setAddPercentOff] = useState("");
  const [addStatus, setAddStatus] = useState("active");
  const [addRuleTouched, setAddRuleTouched] = useState(false);
  const [editRuleId, setEditRuleId] = useState(null);
  const [editPoints, setEditPoints] = useState("");
  const [editPercentOff, setEditPercentOff] = useState("");
  const [editStatus, setEditStatus] = useState("active");
  const [editRuleTouched, setEditRuleTouched] = useState(false);

  useEffect(() => {
    if (configFetcher.state !== "idle") return;
    if (!configFetcher.data?.ok || !configFetcher.data?.savedAt) return;
    if (configFetcher.data.savedAt === originalValuesRef.current.savedAt) return;
    originalValuesRef.current = {
      pointsPerDollar,
      pointsExpirationDays,
      isActive,
      savedAt: configFetcher.data.savedAt,
    };
    if (!shopify?.toast) return;
    shopify.toast.show("Settings saved");
    revalidator.revalidate();
  }, [
    configFetcher.data,
    configFetcher.state,
    isActive,
    pointsExpirationDays,
    pointsPerDollar,
    revalidator,
    shopify,
  ]);

  const errors = useMemo(
    () => ({
      pointsPerDollar: configFetcher.data?.errors?.pointsPerDollar ?? "",
      pointsExpirationDays: configFetcher.data?.errors?.pointsExpirationDays ?? "",
    }),
    [configFetcher.data],
  );

  const discountRuleErrors = useMemo(
    () => ({
      form: rulesFetcher.data?.errors?.form ?? "",
      points: rulesFetcher.data?.errors?.points ?? "",
      percentOff: rulesFetcher.data?.errors?.percentOff ?? "",
    }),
    [rulesFetcher.data],
  );

  const handleSave = (event) => {
    event.preventDefault();
    configFetcher.submit(event.currentTarget, { method: "post" });
  };

  const handleDiscard = (event) => {
    event.preventDefault();
    setPointsPerDollar(originalValuesRef.current.pointsPerDollar);
    setPointsExpirationDays(originalValuesRef.current.pointsExpirationDays);
    setIsActive(originalValuesRef.current.isActive);
  };

  const lastRulesSavedAtRef = useRef(null);
  useEffect(() => {
    if (rulesFetcher.state !== "idle") return;
    if (!rulesFetcher.data?.ok || !rulesFetcher.data?.savedAt) return;
    if (rulesFetcher.data.savedAt === lastRulesSavedAtRef.current) return;

    lastRulesSavedAtRef.current = rulesFetcher.data.savedAt;

    if (rulesFetcher.data.intent === "create_discount_rule") {
      const modalEl = document.getElementById("addDiscountRule");
      if (modalEl && typeof modalEl.hideOverlay === "function") {
        modalEl.hideOverlay();
      }
      setAddPoints("");
      setAddPercentOff("");
      setAddStatus("active");
      setAddRuleTouched(false);
      shopify?.toast?.show("Discount rule added");
    }

    if (rulesFetcher.data.intent === "update_discount_rule") {
      const modalEl = document.getElementById("editDiscountRule");
      if (modalEl && typeof modalEl.hideOverlay === "function") {
        modalEl.hideOverlay();
      }
      setEditRuleId(null);
      setEditRuleTouched(false);
      shopify?.toast?.show("Discount rule updated");
    }

    if (rulesFetcher.data.intent === "delete_discount_rule") {
      shopify?.toast?.show("Discount rule deleted");
    }

    revalidator.revalidate();
  }, [revalidator, rulesFetcher.data, rulesFetcher.state, shopify]);

  const serverRuleIntent = rulesFetcher.data?.ok === false ? rulesFetcher.data.intent : null;
  const shouldShowAddRuleErrors =
    addRuleTouched || serverRuleIntent === "create_discount_rule";
  const shouldShowEditRuleErrors =
    editRuleTouched || serverRuleIntent === "update_discount_rule";

  const getPointsValidationError = ({ value, excludeRuleId }) => {
    const normalized = String(value ?? "").trim();
    if (!normalized) return "Must be a number";
    if (!/^\d+$/.test(normalized)) return "Must be a number";
    const points = Number.parseInt(normalized, 10);
    if (!Number.isFinite(points) || !Number.isInteger(points) || points < 0) {
      return "Must be a whole number (0 or higher).";
    }
    const duplicate = discountRules.some(
      (rule) => rule.points === points && rule.id !== excludeRuleId,
    );
    if (duplicate) return "A rule with this points value already exists";
    return "";
  };

  const getPercentOffValidationError = ({ value }) => {
    const normalized = String(value ?? "").trim();
    if (!normalized) return "Must be a number";
    if (!/^\d+$/.test(normalized)) return "Must be a number";
    const percentOff = Number.parseInt(normalized, 10);
    if (
      !Number.isFinite(percentOff) ||
      !Number.isInteger(percentOff) ||
      percentOff < 1 ||
      percentOff > 100
    ) {
      return "Must be between 1-100%";
    }
    return "";
  };

  const addPointsErrorLocal = getPointsValidationError({
    value: addPoints,
    excludeRuleId: null,
  });
  const addPercentOffErrorLocal = getPercentOffValidationError({
    value: addPercentOff,
  });
  const editPointsErrorLocal = editRuleId
    ? getPointsValidationError({ value: editPoints, excludeRuleId: editRuleId })
    : "Must be a number";
  const editPercentOffErrorLocal = getPercentOffValidationError({
    value: editPercentOff,
  });

  const addPointsError =
    shouldShowAddRuleErrors
      ? addPointsErrorLocal ||
        (serverRuleIntent === "create_discount_rule"
          ? discountRuleErrors.points
          : "")
      : "";
  const addPercentOffError =
    shouldShowAddRuleErrors
      ? addPercentOffErrorLocal ||
        (serverRuleIntent === "create_discount_rule"
          ? discountRuleErrors.percentOff
          : "")
      : "";
  const editPointsError =
    shouldShowEditRuleErrors
      ? editPointsErrorLocal ||
        (serverRuleIntent === "update_discount_rule"
          ? discountRuleErrors.points
          : "")
      : "";
  const editPercentOffError =
    shouldShowEditRuleErrors
      ? editPercentOffErrorLocal ||
        (serverRuleIntent === "update_discount_rule"
          ? discountRuleErrors.percentOff
          : "")
      : "";

  const submitCreateDiscountRule = () => {
    setAddRuleTouched(true);
    if (addPointsErrorLocal || addPercentOffErrorLocal) {
      return;
    }
    const data = new FormData();
    data.set("intent", "create_discount_rule");
    data.set("points", addPoints);
    data.set("percentOff", addPercentOff);
    data.set("status", addStatus);
    rulesFetcher.submit(data, { method: "post" });
  };

  const submitUpdateDiscountRule = () => {
    if (!editRuleId) return;
    setEditRuleTouched(true);
    if (editPointsErrorLocal || editPercentOffErrorLocal) {
      return;
    }
    const data = new FormData();
    data.set("intent", "update_discount_rule");
    data.set("id", String(editRuleId));
    data.set("points", editPoints);
    data.set("percentOff", editPercentOff);
    data.set("status", editStatus);
    rulesFetcher.submit(data, { method: "post" });
  };

  const startEditingRule = (rule) => {
    setEditRuleId(rule.id);
    setEditPoints(String(rule.points));
    setEditPercentOff(String(rule.percentOff));
    setEditStatus(rule.isActive ? "active" : "inactive");
    setEditRuleTouched(false);
  };

  const openEditDiscountRule = (rule) => {
    startEditingRule(rule);
    const modalEl = document.getElementById("editDiscountRule");
    if (!modalEl || typeof modalEl.showOverlay !== "function") return;
    setTimeout(() => modalEl.showOverlay(), 0);
  };

  const isRulesSubmitting = rulesFetcher.state !== "idle";
  const rulesSubmissionIntent = rulesFetcher.submission?.formData?.get("intent");

  return (
    <s-page heading="Settings" inlineSize="small">
      <s-stack direction="block" gap="base">
        {!config.configuredPointsPerDollar ? (
          <s-banner tone="critical">
            You need to configure how many points customers will earn per
            dollar spent.
          </s-banner>
        ) : null}
        {!hasDiscountRule ? (
          <s-banner tone="caution">
            You need at least one discount rule for customers to
            spend their points.
          </s-banner>
        ) : null}

        <s-section>
          <form data-save-bar onSubmit={handleSave} onReset={handleDiscard}>
            <input type="hidden" name="intent" value="save_config" />
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
                name="isActive"
                value={isActive ? "active" : "inactive"}
                onChange={(event) =>
                  setIsActive(event.currentTarget.value === "active")
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
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
              <s-heading>Discount rules</s-heading>
              <s-button commandFor="addDiscountRule" variant="primary">Create discount rule</s-button>
            </s-stack>

            {discountRuleErrors.form ? (
              <s-text color="critical">{discountRuleErrors.form}</s-text>
            ) : null}

            {Array.isArray(discountRules) && discountRules.length ? (
              <s-stack direction="block" gap="small">
                {discountRules.map((rule) => (
                  <s-stack
                    key={rule.id}
                    direction="inline"
                    justifyContent="space-between"
                    alignItems="center"
                    gap="base"
                  >
                    <s-text>
                      {rule.points} points for {rule.percentOff}% off order
                      {!rule.isActive ? " (Inactive)" : ""}
                    </s-text>
                    <s-stack direction="inline" gap="small-400">
                      <s-button
                        icon="edit"
                        variant="tertiary"
                        onClick={() => openEditDiscountRule(rule)}
                        accessibilityLabel="Edit discount rule"
                      />
                      <s-button
                        icon="delete"
                        variant="tertiary"
                        onClick={() => {
                          const data = new FormData();
                          data.set("intent", "delete_discount_rule");
                          data.set("id", String(rule.id));
                          rulesFetcher.submit(data, { method: "post" });
                        }}
                        disabled={isRulesSubmitting}
                        accessibilityLabel="Delete discount rule"
                      />
                    </s-stack>
                  </s-stack>
                ))}
              </s-stack>
            ) : (
              <s-text color="subdued">No discount rules yet.</s-text>
            )}
          </s-stack>

          <s-modal id="addDiscountRule" heading="Create discount rule">
            <s-stack direction="block" gap="base">
              <s-text-field
                label="Points"
                value={addPoints}
                error={addPointsError}
                onChange={(event) => setAddPoints(event.currentTarget.value)}
              />
              <s-text-field
                label="Percent off order"
                value={addPercentOff}
                error={addPercentOffError}
                onChange={(event) => setAddPercentOff(event.currentTarget.value)}
              />
              <s-select
                label="Status"
                value={addStatus}
                onChange={(event) => setAddStatus(event.currentTarget.value)}
              >
                <s-option value="active">Active</s-option>
                <s-option value="inactive">Inactive</s-option>
              </s-select>
            </s-stack>

            <s-button slot="secondary-actions" commandFor="addDiscountRule" command="--hide">
              Close
            </s-button>
            <s-button
              slot="primary-action"
              variant="primary"
              disabled={isRulesSubmitting}
              loading={isRulesSubmitting && rulesSubmissionIntent === "create_discount_rule"}
              onClick={submitCreateDiscountRule}
            >
              Save
            </s-button>
          </s-modal>

          <s-modal id="editDiscountRule" heading="Edit discount rule">
            <s-stack direction="block" gap="base">
              <s-text-field
                label="Points"
                value={editPoints}
                error={editPointsError}
                onChange={(event) => setEditPoints(event.currentTarget.value)}
              />
              <s-text-field
                label="Percent off order"
                value={editPercentOff}
                error={editPercentOffError}
                onChange={(event) => setEditPercentOff(event.currentTarget.value)}
              />
              <s-select
                label="Status"
                value={editStatus}
                onChange={(event) => setEditStatus(event.currentTarget.value)}
              >
                <s-option value="active">Active</s-option>
                <s-option value="inactive">Inactive</s-option>
              </s-select>
            </s-stack>

            <s-button slot="secondary-actions" commandFor="editDiscountRule" command="--hide">
              Close
            </s-button>
            <s-button
              slot="primary-action"
              variant="primary"
              disabled={isRulesSubmitting || !editRuleId}
              loading={isRulesSubmitting && rulesSubmissionIntent === "update_discount_rule"}
              onClick={submitUpdateDiscountRule}
            >
              Save
            </s-button>
          </s-modal>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
