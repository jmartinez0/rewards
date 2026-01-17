import crypto from "node:crypto";

const timingSafeEqual = (a, b) => {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
};

const buildMessage = (searchParams) => {
  const pairs = [];

  for (const [key, value] of searchParams.entries()) {
    if (key === "hmac" || key === "signature") continue;
    pairs.push([key, value]);
  }

  pairs.sort(([a], [b]) => a.localeCompare(b));

  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
};

const verifyAppProxyHmac = (url) => {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return { ok: false, reason: "missing_secret" };

  const hmac = url.searchParams.get("hmac");
  if (!hmac) return { ok: false, reason: "missing_hmac" };

  const message = buildMessage(url.searchParams);
  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");

  return { ok: timingSafeEqual(digest, hmac), reason: "invalid_hmac" };
};

const json = (data, init = {}) => {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
};

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const verification = verifyAppProxyHmac(url);
  if (!verification.ok) {
    return json({ ok: false }, { status: 401 });
  }

  return json({ ok: true });
};

export const action = async ({ request }) => {
  const url = new URL(request.url);
  const verification = verifyAppProxyHmac(url);
  if (!verification.ok) {
    return json({ ok: false }, { status: 401 });
  }

  // Placeholder for storefront cart page calls.
  // Implement redemption/discount-code creation here.
  return json({ ok: true });
};

