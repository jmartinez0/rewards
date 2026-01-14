import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  useApi,
  useSessionToken,
  useSettings,
  useSubscription,
} from "@shopify/ui-extensions/checkout/preact";

const DEFAULT_APP_URL = "https://jm-rewards-staging.vercel.app";

const loadedOrders = new Set();

export default function extension() {
  render(<PointsEarnedBanner />, document.body);
}

function PointsEarnedBanner() {
  const api = useApi("purchase.thank-you.block.render");
  const orderConfirmation = useSubscription(api.orderConfirmation);
  const rawSessionToken = useSessionToken();
  const settings = useSettings();
  const [pointsEarned, setPointsEarned] = useState(null);

  const extension = api.extension;
  let isPreviewContext = false;
  try {
    // Prevent extension from displaying twice during development
    if (extension && extension.scriptUrl) {
      const url = new URL(extension.scriptUrl);
      const hostname = url.hostname;
      const version = extension.version;

      const isCdnHost = hostname.endsWith("extensions.shopifycdn.com");
      const isDevVersion =
        typeof version === "string" && version.startsWith("dev-");
      isPreviewContext = isCdnHost && isDevVersion;
    }
  } catch (e) {
    console.log("Failed to parse scriptUrl for context", e);
  }

  useEffect(() => {
    const orderId = orderConfirmation && orderConfirmation.order
      ? orderConfirmation.order.id
      : null;

    if (!orderId || !rawSessionToken) {
      return;
    }

    if (isPreviewContext) {
      console.log("Skipping points fetch in preview/CDN dev context",
        {
          scriptUrl: extension && extension.scriptUrl,
          orderId,
        },
      );
      return;
    }

    if (loadedOrders.has(orderId)) {
      console.log("[JM Rewards] Points already loaded for order in this sandbox", { orderId });
      return;
    }
    loadedOrders.add(orderId);

    let cancelled = false;
    let appUrl = String(settings && settings.app_url ? settings.app_url : DEFAULT_APP_URL).trim();
    if (!/^https?:\/\//i.test(appUrl)) {
      appUrl = `https://${appUrl}`;
    }
    appUrl = appUrl.replace(/\/$/, "");

    const loadPointsWithRetry = async () => {
      try {
        let tokenString;
        if (typeof rawSessionToken === "string") {
          tokenString = rawSessionToken;
        } else if (
          rawSessionToken &&
          typeof rawSessionToken.get === "function"
        ) {
          tokenString = await rawSessionToken.get();
        } else {
          console.log("Unexpected sessionToken type:", rawSessionToken);
          return;
        }

        if (!tokenString) {
          console.log("Empty session token");
          return;
        }

        const makeRequest = async () => {
          const url = new URL("/api/points-earned", appUrl);
          url.searchParams.set("orderId", orderId);

          const res = await fetch(url.toString(), {
            headers: {
              Authorization: `Bearer ${tokenString}`,
            },
          });
          if (!res.ok) {
            console.warn("Points API not OK:", res.status);
            return null;
          }

          const data = await res.json();
          if (!data || typeof data.pointsEarned !== "number") {
            return 0;
          }
          return data.pointsEarned;
        };

        const maxAttempts = 10;
        const delayMs = 250;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (cancelled) return;

          const pts = await makeRequest();

          if (typeof pts === "number" && pts > 0) {
            if (!cancelled) {
              setPointsEarned(pts);
            }
            return;
          }

          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          } else {
            if (!cancelled) {
              setPointsEarned(0);
            }
          }
        }
      } catch (error) {
        console.error("Failed to load points earned: ", error);
      }
    };

    loadPointsWithRetry();

    return () => {
      cancelled = true;
    };
  }, [
    orderConfirmation && orderConfirmation.order
      ? orderConfirmation.order.id
      : null,
    rawSessionToken,
    settings && settings.app_url ? settings.app_url : null,
    isPreviewContext,
    extension && extension.scriptUrl ? extension.scriptUrl : null,
  ]);

  if (pointsEarned == null || pointsEarned <= 0) {
    return null;
  }

  return (
    <s-banner tone="success" heading={`You earned ${pointsEarned} points!`}>
      <s-text type="small">You can redeem them on your next purchase.</s-text>
    </s-banner>
  );
}
