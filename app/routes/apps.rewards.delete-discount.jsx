import { authenticate, unauthenticated } from "../shopify.server";

const log = (...args) => {
  console.log("[apps/rewards/delete-discount]", ...args);
};

export async function action({ request }) {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id");

  if (!shop) {
    return new Response("Missing shop", { status: 400 });
  }

  if (!loggedInCustomerId) {
    return new Response("Customer not logged in", { status: 401 });
  }

  log("Request", { shop, loggedInCustomerId });

  let code;
  try {
    const body = await request.json();
    code = String(body?.code ?? "").trim();
  } catch (error) {
    return new Response("Invalid JSON body", { status: 400 });
  }

  if (!code) {
    return new Response("Missing code", { status: 400 });
  }

  const { admin } = await unauthenticated.admin(shop);

  const lookupQuery = `
    query CodeDiscountNodeByCode($code: String!) {
      codeDiscountNodeByCode(code: $code) {
        id
      }
    }
  `;

  const lookupRes = await admin.graphql(lookupQuery, { variables: { code } });
  const lookupJson = await lookupRes.json();
  const discountNodeId = lookupJson?.data?.codeDiscountNodeByCode?.id ?? null;

  if (!discountNodeId) {
    log("Discount code not found", { shop, loggedInCustomerId, code });
    return new Response("OK", { status: 200 });
  }

  const deleteMutation = `
    mutation DiscountCodeDelete($id: ID!) {
      discountCodeDelete(id: $id) {
        deletedCodeDiscountId
        userErrors {
          field
          message
        }
      }
    }
  `;

  const deleteRes = await admin.graphql(deleteMutation, {
    variables: { id: discountNodeId },
  });
  const deleteJson = await deleteRes.json();
  const userErrors = deleteJson?.data?.discountCodeDelete?.userErrors ?? [];

  if (userErrors.length > 0) {
    log("Delete failed", { shop, loggedInCustomerId, code, userErrors });
    return new Response("Failed to delete discount", { status: 502 });
  }

  log("Deleted", { shop, loggedInCustomerId, code });
  return new Response("OK", { status: 200 });
}
