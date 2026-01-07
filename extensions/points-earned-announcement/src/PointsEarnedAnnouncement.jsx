// src/PointsEarnedAnnouncement.jsx
import '@shopify/ui-extensions/preact';
import {render} from 'preact';

export default function extension() {
  // TODO: replace with real calculation or data
  const pointsEarned = 598;

  render(<PointsEarnedAnnouncement points={pointsEarned} />, document.body);
}

function PointsEarnedAnnouncement({points}) {
  return (
    <s-banner
      tone="success"
      heading={`You earned ${points} points!`}
    >
      <s-text type="small">
        You can redeem them on your next purchase.
      </s-text>
    </s-banner>
  );
}