import { authenticate, unauthenticated } from "../shopify.server";

const log = (...args) => {
  console.log("[apps/rewards/delete-discount]", ...args);
};

const NOINDEX_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow",
};

export async function loader() {
  return new Response("Not found", {
    status: 404,
    headers: NOINDEX_HEADERS,
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...NOINDEX_HEADERS,
    },
  });
}

function textResponse(text, status) {
  return new Response(text, {
    status,
    headers: NOINDEX_HEADERS,
  });
}

export async function action({ request }) {
  try {
    await authenticate.public.appProxy(request);

    const url = new URL(request.url);
    const shop = url.searchParams.get("shop");
    const loggedInCustomerId = url.searchParams.get("logged_in_customer_id");

    if (!shop) {
      return textResponse("Missing shop", 400);
    }

    if (!loggedInCustomerId) {
      return textResponse("Customer not logged in", 401);
    }

    log("Request", { shop, loggedInCustomerId });

    let code;
    try {
      const body = await request.json();
      code = String(body?.code ?? "").trim();
    } catch {
      return textResponse("Invalid JSON body", 400);
    }

    if (!code) {
      return textResponse("Missing code", 400);
    }

    const { admin } = await unauthenticated.admin(shop);

    const lookupQuery = `
      query CodeDiscountNodeByCode($code: String!) {
        codeDiscountNodeByCode(code: $code) {
          id
        }
      }
    `;

    const lookupRes = await admin.graphql(lookupQuery, {
      variables: { code },
    });
    const lookupJson = await lookupRes.json();
    const discountNodeId =
      lookupJson?.data?.codeDiscountNodeByCode?.id ?? null;

    if (!discountNodeId) {
      log("Discount code not found", { shop, loggedInCustomerId, code });
      return textResponse("OK", 200);
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
    const userErrors =
      deleteJson?.data?.discountCodeDelete?.userErrors ?? [];

    if (userErrors.length > 0) {
      log("Delete failed", {
        shop,
        loggedInCustomerId,
        code,
        userErrors,
      });
      return textResponse("Failed to delete discount", 502);
    }

    log("Deleted", { shop, loggedInCustomerId, code });
    return textResponse("OK", 200);
  } catch (err) {
    log("Unhandled error in action", err);
    return textResponse("Internal server error", 500);
  }
}
