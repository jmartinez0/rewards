CREATE UNIQUE INDEX rewards_ledger_earn_order_unique
ON "RewardsLedgerEntry" ("orderId")
WHERE "type" = 'EARN';
