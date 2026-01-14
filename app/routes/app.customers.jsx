import { Outlet, useLoaderData, useParams, useSearchParams } from "react-router";
import { useEffect, useRef, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const pageParam = Number.parseInt(url.searchParams.get("page") || "1", 10);
  const page = Number.isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;
  const pageSize = 50;

  const numericQuery = Number.parseInt(query, 10);
  const searchTerms = query
    ? {
      OR: [
        { email: { contains: query, mode: "insensitive" } },
        { name: { contains: query, mode: "insensitive" } },
        ...(Number.isNaN(numericQuery)
          ? []
          : [
            { currentPoints: numericQuery },
            { lifetimePoints: numericQuery },
          ]),
      ],
    }
    : undefined;

  const total = await db.customer.count({
    where: searchTerms,
  });

  const customers = await db.customer.findMany({
    where: searchTerms,
    orderBy: { createdAt: "desc" },
    take: pageSize,
    skip: (page - 1) * pageSize,
  });

  return { customers, total, page, pageSize, query };
};

export default function Customers() {
  const {
    customers,
    total,
    page,
    pageSize,
    query: initialQuery,
  } = useLoaderData();
  const { id } = useParams();

  const [searchParams, setSearchParams] = useSearchParams();

  const [query, setQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);
  const lastAppliedQueryRef = useRef(initialQuery);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const saved = sessionStorage.getItem("customersScroll");
    if (!saved) return;
    sessionStorage.removeItem("customersScroll");
    const y = Number(saved);
    if (!Number.isNaN(y)) {
      window.scrollTo(0, y);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    const normalized = debouncedQuery.trim();
    if (normalized === lastAppliedQueryRef.current) {
      return;
    }

    const currentQuery = searchParams.get("q") || "";
    const nextQuery = normalized || "";
    const currentPage = searchParams.get("page") || "1";
    const nextPage = "1";

    if (currentQuery === nextQuery && currentPage === nextPage) {
      return;
    }

    if (nextQuery) {
      params.set("q", nextQuery);
    } else {
      params.delete("q");
    }

    params.set("page", nextPage);
    lastAppliedQueryRef.current = normalized;
    setSearchParams(params, { replace: true });
  }, [debouncedQuery, searchParams, setSearchParams]);

  const totalCustomers = total;
  const startIndex = totalCustomers === 0 ? 0 : (page - 1) * pageSize + 1;
  const endIndex = Math.min(page * pageSize, totalCustomers);
  const hasPreviousPage = page > 1;
  const hasNextPage = page * pageSize < totalCustomers;
  const searchSuffix = searchParams.toString();

  if (id) {
    return <Outlet />;
  }

  return (
    <s-page heading="Customers">
      {totalCustomers === 0 && !query ? (
        <s-section padding="base">
          <s-paragraph>No rewards customers found yet.</s-paragraph>
          <s-paragraph><strong>Before customers can be rewarded</strong>, go to <s-link href="/app/settings">settings</s-link> and save your custom configuration.</s-paragraph>
          <s-paragraph><strong>After your configuration is saved</strong>, when a customer places a new order, their rewards account will be created automatically.</s-paragraph>
        </s-section>
      ) : (
        <s-stack direction="block" gap="base">
          <s-search-field
            label="Search customers"
            labelAccessibilityVisibility="exclusive"
            placeholder="Search customers"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          ></s-search-field>

          <s-section padding="none">
            <s-box>
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Name</s-table-header>
                  <s-table-header>Email</s-table-header>
                  <s-table-header>Current points</s-table-header>
                  <s-table-header>Lifetime points</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {customers.length === 0 ? (
                    <s-table-row>
                      <s-table-cell>No results found.</s-table-cell>
                    </s-table-row>
                  ) : (
                    customers.map((customer) => (
                      <s-table-row
                        key={customer.id}
                        clickDelegate={`customer-${customer.id}`}
                      >
                        <s-table-cell>
                          <s-link
                            id={`customer-${customer.id}`}
                            href={`/app/customers/${customer.id}${
                              searchSuffix ? `?${searchSuffix}` : ""
                            }`}
                            accessibilityLabel={`View ${customer.name || customer.email}`}
                            onClick={() => {
                              sessionStorage.setItem(
                                "customersScroll",
                                String(window.scrollY),
                              );
                            }}
                          >
                            {customer.name ?? "—"}
                          </s-link>
                        </s-table-cell>
                        <s-table-cell>{customer.email}</s-table-cell>
                        <s-table-cell>{customer.currentPoints}</s-table-cell>
                        <s-table-cell>{customer.lifetimePoints}</s-table-cell>
                      </s-table-row>
                    ))
                  )}
                </s-table-body>
              </s-table>

              {totalCustomers > 50 && (
                <div
                  style={{
                    borderTop: "0.5px solid rgb(227 227 227)",
                    position: "sticky",
                    bottom: 0,
                    zIndex: 10,
                  }}
                >
                  <s-box background="subdued" padding="small-200">
                    <s-stack
                      direction="inline"
                      justifyContent="start"
                      alignItems="center"
                      gap="small-100"
                    >
                      <s-button-group
                        gap="none"
                        accessibilityLabel="Pagination controls"
                      >
                        <s-button
                          slot="secondary-actions"
                          variant="secondary"
                          icon="chevron-left"
                          accessibilityLabel="Previous page"
                          disabled={!hasPreviousPage}
                          onClick={() => {
                            const params = new URLSearchParams(searchParams);
                            params.set("page", String(Math.max(page - 1, 1)));
                            setSearchParams(params);
                          }}
                        />

                        <s-button
                          slot="secondary-actions"
                          variant="secondary"
                          icon="chevron-right"
                          accessibilityLabel="Next page"
                          disabled={!hasNextPage}
                          onClick={() => {
                            const params = new URLSearchParams(searchParams);
                            params.set("page", String(page + 1));
                            setSearchParams(params);
                          }}
                        />
                      </s-button-group>

                      <s-text color="subdued">
                        {totalCustomers === 0 ? "0" : `${startIndex}-${endIndex}`}
                      </s-text>
                    </s-stack>
                  </s-box>
                </div>
              )}
            </s-box>
          </s-section>
        </s-stack>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
