import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/PointsEarnedBanner.jsx' {
  const shopify: import('@shopify/ui-extensions/purchase.thank-you.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}
