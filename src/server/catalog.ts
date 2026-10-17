import { Prisma } from "@prisma/client";
import type { Product } from "../domain";
import { db, locationId } from "./db";

export async function catalog(client: Pick<Prisma.TransactionClient, "product"> = db): Promise<Product[]> {
  const products = await client.product.findMany({ where: { locationId: locationId() },
    include: { tax: true, groups: { include: { modifiers: { orderBy: { id: "asc" } } }, orderBy: { id: "asc" } } }, orderBy: { id: "asc" } });
  return products.map(product => ({
    id: product.id, cloverId: product.cloverId, name: product.name, description: product.description,
    categoryId: product.categoryId, price: product.price, taxBps: product.tax.bps,
    available: product.available, version: product.version,
    groups: product.groups.map(group => ({ id: group.id, name: group.name, min: group.min, max: group.max,
      modifiers: group.modifiers.map(modifier => ({ id: modifier.id, cloverId: modifier.cloverId, name: modifier.name,
        price: modifier.price, available: modifier.available, maxQuantity: modifier.maxQuantity })) })),
  }));
}
