import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const customers = await db.rewardsCustomer.findMany({
    orderBy: { createdAt: "desc" },
  });

  return { customers };
};

export default function Customers() {
  const { customers } = useLoaderData();

  return (
    <s-page heading="Customers">
      <s-section heading="Rewards customers">
        {customers.length === 0 ? (
          <s-paragraph>No rewards customers yet.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {customers.map((customer) => (
              <s-box
                key={customer.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <s-stack direction="block" gap="base">
                  <s-text>{customer.email}</s-text>
                  {customer.shopifyCustomerId && (
                    <s-text>Shopify ID: {customer.shopifyCustomerId}</s-text>
                  )}
                  <s-text>Current points: {customer.currentPoints}</s-text>
                  <s-text>Lifetime points: {customer.lifetimePoints}</s-text>
                  <s-text>
                    Joined: {new Date(customer.createdAt).toLocaleString()}
                  </s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
