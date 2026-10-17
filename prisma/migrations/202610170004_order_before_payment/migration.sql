-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "providerOrderId" TEXT,
ALTER COLUMN "paymentState" SET DEFAULT 'PROCESSING',
ALTER COLUMN "integrationState" SET DEFAULT 'NOT_CREATED',
ALTER COLUMN "fulfillmentState" SET DEFAULT 'SUBMITTED';

-- CreateIndex
CREATE UNIQUE INDEX "Order_providerOrderId_key" ON "Order"("providerOrderId");

UPDATE "Order" SET "paymentState" = CASE "paymentState"
  WHEN 'PENDING' THEN 'PROCESSING'
  WHEN 'DECLINED' THEN 'FAILED'
  WHEN 'UNKNOWN' THEN 'UNKNOWN_REQUIRES_RECONCILIATION'
  ELSE "paymentState" END,
  "fulfillmentState" = CASE "fulfillmentState"
  WHEN 'NEW' THEN 'SUBMITTED'
  WHEN 'COLLECTED' THEN 'COMPLETED'
  WHEN 'REJECTED' THEN 'CANCELLED'
  ELSE "fulfillmentState" END,
  "integrationState" = CASE "integrationState"
  WHEN 'PENDING' THEN 'NOT_CREATED' ELSE "integrationState" END;
UPDATE "Order" SET "paymentState" = 'PARTIALLY_REFUNDED'
WHERE "paymentState" = 'PAID' AND "refundedAmount" > 0;
UPDATE "Order" AS orders SET "providerOrderId" = provider."providerId"
FROM "MockProviderRecord" AS provider
WHERE provider."orderId" = orders.id AND provider.operation = 'ORDER';

-- Upgrade pending mock jobs from the initial payment-first development flow.
UPDATE "Outbox" AS jobs SET kind = 'SUBMIT_ORDER', "dedupeKey" = 'submit:' || jobs."aggregateId",
  state = 'PENDING', "leaseToken" = NULL, "leaseUntil" = NULL
WHERE jobs.kind IN ('PAYMENT', 'RECONCILE_PAYMENT') AND jobs.state IN ('PENDING', 'RUNNING', 'DEAD')
AND NOT EXISTS (SELECT 1 FROM "MockProviderRecord" provider WHERE provider."orderId" = jobs."aggregateId" AND provider.operation = 'ORDER')
AND NOT EXISTS (SELECT 1 FROM "Outbox" submitted WHERE submitted."dedupeKey" = 'submit:' || jobs."aggregateId");
