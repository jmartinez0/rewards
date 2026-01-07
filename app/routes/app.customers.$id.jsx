import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const id = Number.parseInt(params.id, 10);
  if (Number.isNaN(id)) {
    throw new Response("Invalid customer id", { status: 400 });
  }

  const customer = await db.rewardsCustomer.findUnique({
    where: { id },
  });

  if (!customer) {
    throw new Response("Customer not found", { status: 404 });
  }

  return { customer };
};

export default function CustomerDetails() {
  const { customer } = useLoaderData();
  const [searchParams] = useSearchParams();
  const searchSuffix = searchParams.toString();
  const backHref = searchSuffix
    ? `/app/customers?${searchSuffix}`
    : "/app/customers";

  return (
    <s-page heading={customer.name || "Customer"}>
      <s-stack direction="block" gap="base">

        <s-stack direction="inline" alignItems="center" gap="small-100">

          <s-button variant="secondary" icon="chevron-left" href={backHref}>

          </s-button>
          <s-heading>{customer.name}</s-heading>
        </s-stack>
        <s-section>
          <s-stack direction="block" gap="base">
            <s-text>
              <s-text type="strong">ID:</s-text> {customer.id}
            </s-text>
            <s-text>
              <s-text type="strong">Name:</s-text> {customer.name ?? "—"}
            </s-text>
            <s-text>
              <s-text type="strong">Email:</s-text> {customer.email}
            </s-text>
            <s-text>
              <s-text type="strong">Shopify customer ID:</s-text>{" "}
              {customer.shopifyCustomerId ?? "—"}
            </s-text>
            <s-text>
              <s-text type="strong">Current points:</s-text>{" "}
              {customer.currentPoints}
            </s-text>
            <s-text>
              <s-text type="strong">Lifetime points:</s-text>{" "}
              {customer.lifetimePoints}
            </s-text>
            <s-heading>WIP. In the future, there will be a full history of points earned and spent with dates and links to the specific orders where they earned/spent points.</s-heading>
          </s-stack>
        </s-section>
      </s-stack>

    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
