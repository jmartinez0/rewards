import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    afterAuth: async ({ admin, session }) => {
      const definitions = [
        {
          name: "Rewards points per dollar",
          namespace: "rewards",
          key: "points_per_dollar",
          type: "number_integer",
          ownerType: "SHOP",
        },
        {
          name: "Rewards expiration days",
          namespace: "rewards",
          key: "expiration_days",
          type: "number_integer",
          ownerType: "SHOP",
        },
        {
          name: "Rewards current points",
          namespace: "rewards",
          key: "current_points",
          type: "number_integer",
          ownerType: "CUSTOMER",
        },
        {
          name: "Rewards lifetime points",
          namespace: "rewards",
          key: "lifetime_points",
          type: "number_integer",
          ownerType: "CUSTOMER",
        },
      ];

      const metafieldDefinitionCreate = `
        mutation MetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition {
              id
              name
              namespace
              key
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      for (const definition of definitions) {
        try {
          const res = await admin.graphql(metafieldDefinitionCreate, {
            variables: { definition },
          });
          const json = await res.json();
          const payload = json?.data?.metafieldDefinitionCreate;
          const errors = payload?.userErrors ?? [];

          if (errors.length > 0) {
            console.log(
              `[afterAuth] metafield definition "${definition.namespace}.${definition.key}" not created:`,
              errors,
            );
          } else {
            console.log(
              `[afterAuth] metafield definition created: ${definition.namespace}.${definition.key}`,
            );
          }
        } catch (error) {
          console.error(
            `[afterAuth] metafield definition "${definition.namespace}.${definition.key}" failed:`,
            error,
          );
        }
      }

      try {
        const shopIdResponse = await admin.graphql(`
          query ShopId {
            shop {
              id
            }
          }
        `);
        const shopIdJson = await shopIdResponse.json();
        const ownerId = shopIdJson?.data?.shop?.id ?? null;

        if (!ownerId) return;

        const setShopMetafields = `
          mutation SetShopMetafields($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors {
                field
                message
              }
            }
          }
        `;

        const setRes = await admin.graphql(setShopMetafields, {
          variables: {
            metafields: [
              {
                ownerId,
                namespace: "rewards",
                key: "points_per_dollar",
                type: "number_integer",
                value: "0",
              },
              {
                ownerId,
                namespace: "rewards",
                key: "expiration_days",
                type: "number_integer",
                value: "0",
              },
            ],
          },
        });
        const setJson = await setRes.json();
        const setErrors = setJson?.data?.metafieldsSet?.userErrors ?? [];
        if (setErrors.length > 0) {
          console.log(
            `[afterAuth] shop metafields not set for ${session.shop}:`,
            setErrors,
          );
        }
      } catch (error) {
        console.error(`[afterAuth] shop metafield setup failed for ${session.shop}:`, error);
      }
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
