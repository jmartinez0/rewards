import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  useApi,
  useSessionToken,
  useSettings,
  useSubscription,
} from "@shopify/ui-extensions/checkout/preact";

const DEFAULT_APP_URL = "https://jm-rewards.vercel.app";

export default function extension() {
  render(<PointsEarnedBanner />, document.body);
}

function PointsEarnedBanner() {
  const api = useApi("purchase.thank-you.block.render");
  const orderConfirmation = useSubscription(api.orderConfirmation);
  const rawSessionToken = useSessionToken();
  const settings = useSettings();
  const [pointsEarned, setPointsEarned] = useState(null);

  useEffect(() => {
    const orderId = orderConfirmation?.order?.id;
    if (!orderId || !rawSessionToken) {
      return;
    }

    let cancelled = false;
    const appUrl = String(settings?.app_url ?? DEFAULT_APP_URL).replace(/\/$/, "");

    const loadPointsWithRetry = async () => {
      try {
        let tokenString;
        if (typeof rawSessionToken === "string") {
          tokenString = rawSessionToken;
        } else if (typeof rawSessionToken.get === "function") {
          tokenString = await rawSessionToken.get();
        } else {
          console.warn("Unexpected sessionToken type:", rawSessionToken);
          return;
        }

        if (!tokenString) {
          console.warn("Empty session token");
          return;
        }

        const makeRequest = async () => {
          const url = `${appUrl}/api/points-earned?orderId=${encodeURIComponent(
            orderId,
          )}&sessionToken=${encodeURIComponent(tokenString)}`;

          const res = await fetch(url);
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
        const delayMs = 300;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (cancelled) return;

          const pts = await makeRequest();

          if (pts && pts > 0) {
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
  }, [orderConfirmation?.order?.id, rawSessionToken, settings?.app_url]);

  if (pointsEarned == null) {
    return null;
  }

  return (
    <s-banner tone="success" heading={`You earned ${pointsEarned} points!`}>
      <s-text type="small">You can redeem them on your next purchase.</s-text>
    </s-banner>
  );
}