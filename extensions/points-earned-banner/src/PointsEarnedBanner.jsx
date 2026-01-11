import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  useApi,
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
  const settings = useSettings();
  const [pointsEarned, setPointsEarned] = useState(null);

  useEffect(() => {
    const orderId = orderConfirmation?.order?.id;
    if (!orderId) return;

    let cancelled = false;
    const appUrl = String(settings?.app_url ?? DEFAULT_APP_URL).replace(/\/$/, "");

    const loadPoints = async () => {
      try {
        const res = await fetch(
          `${appUrl}/api/points-earned?orderId=${encodeURIComponent(orderId)}`
        );

        if (!res.ok) return;

        const data = await res.json();
        if (!cancelled) {
          setPointsEarned(data?.pointsEarned ?? 0);
        }
      } catch (err) {
        console.error("Failed to load points earned:", err);
      }
    };

    loadPoints();
    return () => { cancelled = true; };
  }, [orderConfirmation?.order?.id, settings?.app_url]);

  if (pointsEarned == null) return null;

  return (
    <s-banner tone="success" heading={`You earned ${pointsEarned} points!`}>
      <s-text type="small">You can redeem them on your next purchase.</s-text>
    </s-banner>
  );
}
