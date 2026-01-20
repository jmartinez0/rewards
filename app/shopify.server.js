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
          name: "Rewards cents to one USD",
          namespace: "rewards",
          key: "cents_to_one_usd",
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
          name: "Rewards active",
          namespace: "rewards",
          key: "is_active",
          type: "boolean",
          ownerType: "SHOP",
        },
        {
          name: "Rewards current rewards (cents)",
          namespace: "rewards",
          key: "current_rewards",
          type: "number_integer",
          ownerType: "CUSTOMER",
        },
        {
          name: "Rewards lifetime rewards (cents)",
          namespace: "rewards",
          key: "lifetime_rewards",
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

      const existingDefinitions = new Set();

      try {
        const queryExisting = `
	          query ExistingRewardsMetafieldDefinitions($ownerType: MetafieldOwnerType!) {
	            metafieldDefinitions(first: 250, ownerType: $ownerType, namespace: "rewards") {
	              nodes {
	                namespace
	                key
	              }
	            }
	          }
	        `;

        const [shopDefsRes, customerDefsRes] = await Promise.all([
          admin.graphql(queryExisting, { variables: { ownerType: "SHOP" } }),
          admin.graphql(queryExisting, { variables: { ownerType: "CUSTOMER" } }),
        ]);

        const [shopDefsJson, customerDefsJson] = await Promise.all([
          shopDefsRes.json(),
          customerDefsRes.json(),
        ]);

        const shopNodes = shopDefsJson?.data?.metafieldDefinitions?.nodes ?? [];
        const customerNodes = customerDefsJson?.data?.metafieldDefinitions?.nodes ?? [];

        [...shopNodes, ...customerNodes].forEach((node) => {
          if (!node?.namespace || !node?.key) return;
          existingDefinitions.add(`${node.namespace}.${node.key}`);
        });
      } catch (error) {
        console.error(`[afterAuth] failed to query existing metafield definitions for ${session.shop}:`, error);
      }

      for (const definition of definitions) {
        const signature = `${definition.namespace}.${definition.key}`;
        if (existingDefinitions.has(signature)) {
          console.log(`[afterAuth] metafield definition exists: ${signature}`);
          continue;
        }

        try {
          const res = await admin.graphql(metafieldDefinitionCreate, {
            variables: { definition },
          });
          const json = await res.json();
          const payload = json?.data?.metafieldDefinitionCreate;
          const errors = payload?.userErrors ?? [];

          if (errors.length > 0) {
            console.log(
              `[afterAuth] metafield definition "${signature}" not created:`,
              errors,
            );
          } else {
            console.log(`[afterAuth] metafield definition created: ${signature}`);
          }
        } catch (error) {
          console.error(
            `[afterAuth] metafield definition "${signature}" failed:`,
            error,
          );
        }
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
