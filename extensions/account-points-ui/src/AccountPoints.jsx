import '@shopify/ui-extensions/customer-account/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export default async function Extension() {
  render(<AccountPoints />, document.body);
}

function AccountPoints() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [rewards, setRewards] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadRewards() {
      console.log('[AccountPoints] loadRewards start');

      try {
        const rawSettings = shopify?.settings?.current;
        console.log('[AccountPoints] settings.current', rawSettings);

        const domain = String(rawSettings?.shop_domain ?? '').trim();
        console.log('[AccountPoints] resolved domain', {
          domain,
          hasDomain: Boolean(domain),
        });

        if (!domain) {
          throw new Error('Missing shop domain setting');
        }

        // 1) Get customer id from the Customer Account GraphQL API
        const customerQuery = {
          query: `
            query GetCustomerId {
              customer {
                id
              }
            }
          `,
        };

        console.log(
          '[AccountPoints] fetching customer id via Customer Account API',
          {
            endpoint: 'shopify:customer-account/api/unstable/graphql.json',
            query: customerQuery,
          },
        );

        let customerResp;
        try {
          customerResp = await fetch(
            'shopify:customer-account/api/unstable/graphql.json',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(customerQuery),
            },
          );
        } catch (fetchErr) {
          console.log('[AccountPoints] Customer API fetch() threw', {
            fetchErr,
            name: fetchErr?.name,
            message: fetchErr?.message,
            stack: fetchErr?.stack,
          });
          throw fetchErr;
        }

        console.log('[AccountPoints] Customer API fetch completed', {
          ok: customerResp.ok,
          status: customerResp.status,
          statusText: customerResp.statusText,
        });

        if (!customerResp.ok) {
          const text = await customerResp.text().catch(() => null);
          console.log('[AccountPoints] customer API non-OK response', {
            status: customerResp.status,
            statusText: customerResp.statusText,
            body: text,
          });
          throw new Error(
            `Failed to load customer id (status ${customerResp.status})`,
          );
        }

        const customerJson = await customerResp.json();
        console.log('[AccountPoints] customer API JSON', customerJson);

        const customerId = customerJson?.data?.customer?.id;
        console.log(
          '[AccountPoints] customer.id from Customer Account API',
          customerId,
        );

        // In editor or weird context: no customer -> just bail quietly
        if (!customerId) {
          console.log(
            '[AccountPoints] No customer id – likely editor/preview, rendering nothing',
          );
          if (!cancelled) {
            setRewards(null);
            setLoading(false);
          }
          return;
        }

        // 2) Call your app proxy with customer_id
        const base = `https://${domain}`.replace(/\/+$/, '');
        const url = `${base}/apps/rewards/current-points?customer_id=${encodeURIComponent(
          customerId,
        )}`;

        console.log('[AccountPoints] about to fetch rewards', { url });

        let response;
        try {
          response = await fetch(url, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
            },
          });
        } catch (fetchErr) {
          console.log('[AccountPoints] rewards fetch() threw', {
            url,
            fetchErr,
            name: fetchErr?.name,
            message: fetchErr?.message,
            stack: fetchErr?.stack,
          });
          throw fetchErr;
        }

        console.log('[AccountPoints] rewards fetch completed', {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
        });

        if (!response.ok) {
          let text = null;
          try {
            text = await response.text();
          } catch (bodyErr) {
            console.log(
              '[AccountPoints] error reading rewards error response body',
              bodyErr,
            );
          }

          console.log('[AccountPoints] Rewards API non-OK response', {
            url,
            status: response.status,
            statusText: response.statusText,
            body: text,
          });

          throw new Error(
            `Failed to load rewards points (status ${response.status})`,
          );
        }

        let data;
        try {
          data = await response.json();
        } catch (jsonErr) {
          console.log(
            '[AccountPoints] error parsing rewards JSON response',
            jsonErr,
          );
          throw new Error('Failed to parse rewards API response as JSON');
        }

        console.log('[AccountPoints] parsed rewards data', data);

        if (!cancelled) {
          setRewards(data);
        }
      } catch (err) {
        console.log('[AccountPoints] Rewards API error (catch)', {
          err,
          name: err?.name,
          message: err?.message,
          stack: err?.stack,
        });

        if (!cancelled) {
          let message = 'Unknown error';
          if (err instanceof Error) {
            message = `${err.name}: ${err.message}`;
          } else if (typeof err === 'string') {
            message = err;
          } else {
            try {
              message = JSON.stringify(err);
            } catch {
              // ignore
            }
          }

          setError(message);
        }
      } finally {
        if (!cancelled) {
          console.log('[AccountPoints] loadRewards finished');
          setLoading(false);
        }
      }
    }

    void loadRewards();

    return () => {
      console.log('[AccountPoints] cleanup, cancelling loadRewards');
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <s-section>
        <s-text>Loading your rewards points…</s-text>
      </s-section>
    );
  }

  if (error) {
    return (
      <s-section>
        <s-text>There was a problem loading your rewards points.</s-text>
        <s-text>Debug info: {String(error)}</s-text>
      </s-section>
    );
  }

  if (!rewards) {
    return null;
  }

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>Rewards</s-heading>
        <s-text>
          Your current points balance: {rewards.currentPoints ?? 0}
        </s-text>
      </s-stack>
    </s-section>
  );
}