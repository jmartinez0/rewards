import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  useApi,
  useSessionToken,
  useSettings,
  useSubscription,
} from "@shopify/ui-extensions/checkout/preact";

const loadedOrders = new Set();

export default function extension() {
  render(<RewardsEarnedBanner />, document.body);
}

function RewardsEarnedBanner() {
  const api = useApi("purchase.thank-you.block.render");
  const orderConfirmation = useSubscription(api.orderConfirmation);
  const rawSessionToken = useSessionToken();
  const settings = useSettings();
  const [rewardsEarnedCents, setRewardsEarnedCents] = useState(null);

  useEffect(() => {
    const orderId =
      orderConfirmation && orderConfirmation.order
        ? orderConfirmation.order.id
        : null;

    let appUrl = String(settings && settings.app_url ? settings.app_url : "").trim();
    if (!appUrl) {
      console.warn("Missing app_url setting for rewards-earned-banner; skipping fetch", {
        orderId,
      });
      return;
    }
    if (!/^https?:\/\//i.test(appUrl)) {
      appUrl = `https://${appUrl}`;
    }
    appUrl = appUrl.replace(/\/$/, "");

    if (!orderId || !rawSessionToken) {
      return;
    }

    let cancelled = false;
    const maxAttempts = 50;
    const delayMs = 50;

    const loadRewardsWithRetry = async () => {
      try {
        if (loadedOrders.has(orderId)) {
          console.log("Rewards already loaded for order in this sandbox", { orderId });
          return;
        }
        loadedOrders.add(orderId);

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
          const url = new URL("/api/rewards-earned", appUrl);
          url.searchParams.set("orderId", orderId);

          const res = await fetch(url.toString(), {
            headers: {
              Authorization: `Bearer ${tokenString}`,
            },
          });
          if (!res.ok) {
            console.warn("Rewards API not OK:", res.status);
            return null;
          }

          const data = await res.json();
          if (!data || typeof data.rewardsEarnedCents !== "number") {
            return 0;
          }
          return data.rewardsEarnedCents;
        };

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (cancelled) return;

          const cents = await makeRequest();

          if (typeof cents === "number" && cents > 0) {
            if (!cancelled) {
              setRewardsEarnedCents(cents);
            }
            return;
          }

          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          } else {
            if (!cancelled) {
              setRewardsEarnedCents(0);
            }
          }
        }
      } catch (error) {
        console.error("Failed to load rewards earned: ", error);
      }
    };

    loadRewardsWithRetry();

    return () => {
      cancelled = true;
    };
  }, [
    orderConfirmation && orderConfirmation.order
      ? orderConfirmation.order.id
      : null,
    rawSessionToken,
    settings && settings.app_url ? settings.app_url : null,
  ]);

  if (rewardsEarnedCents == null || rewardsEarnedCents <= 0) {
    return null;
  }

  return (
    <s-banner tone="success" heading={`You earned $${(rewardsEarnedCents / 100).toFixed(2)} in rewards!`}>
      <s-text type="small">You can apply your rewards on your next order.</s-text>
    </s-banner>
  );
}
