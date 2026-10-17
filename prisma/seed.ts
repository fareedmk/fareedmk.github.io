import "dotenv/config";
import { db, locationId, requireMockMode } from "../src/server/db";

type Group = { id: string; name: string; min: number; max: number; modifiers: { id: string; name: string; price: number; maxQuantity?: number }[] };
const milk = (id: string): Group => ({ id: `${id}-milk`, name: "Choose your milk", min: 1, max: 1, modifiers: [
  { id: `${id}-whole`, name: "Whole milk", price: 0 }, { id: `${id}-oat`, name: "Oat drink", price: 50 },
  { id: `${id}-almond`, name: "Almond drink", price: 50 },
] });
const size = (id: string): Group => ({ id: `${id}-size`, name: "Drink size", min: 1, max: 1, modifiers: [
  { id: `${id}-regular`, name: "Regular · 12 fl oz", price: 0 }, { id: `${id}-large`, name: "Large · 16 fl oz", price: 90 },
] });
const temperature = (id: string): Group => ({ id: `${id}-temperature`, name: "Hot or iced", min: 1, max: 1, modifiers: [
  { id: `${id}-hot`, name: "Hot", price: 0 }, { id: `${id}-iced`, name: "Iced", price: 0 },
] });
const sweetness = (id: string): Group => ({ id: `${id}-sweetness`, name: "Sweetness", min: 1, max: 1, modifiers: [
  { id: `${id}-unsweetened`, name: "No added sweetener", price: 0 },
  { id: `${id}-lightly-sweet`, name: "Lightly sweet", price: 0 }, { id: `${id}-sweet`, name: "Regular sweetness", price: 0 },
] });
const extras = (id: string): Group => ({ id: `${id}-extras`, name: "Coffee extras", min: 0, max: 3, modifiers: [
  { id: `${id}-shot`, name: "Extra espresso shot", price: 70, maxQuantity: 2 },
  { id: `${id}-vanilla`, name: "Vanilla syrup", price: 40 },
] });
const flavours = (id: string, maximum: number): Group => ({ id: `${id}-flavours`, name: "Gelato flavours", min: maximum, max: maximum, modifiers: [
  { id: `${id}-pistachio`, name: "Pistachio", price: 80, maxQuantity: maximum },
  { id: `${id}-chocolate`, name: "Dark chocolate", price: 0, maxQuantity: maximum },
  { id: `${id}-vanilla`, name: "Madagascan vanilla", price: 0, maxQuantity: maximum },
  { id: `${id}-mango`, name: "Mango sorbet", price: 0, maxQuantity: maximum },
] });
const serving = (id: string): Group => ({ id: `${id}-serving`, name: "Cup or cone", min: 1, max: 1, modifiers: [
  { id: `${id}-cup`, name: "Cup", price: 0 }, { id: `${id}-cone`, name: "Waffle cone", price: 50 },
] });
const toppings = (id: string): Group => ({ id: `${id}-toppings`, name: "Gelato toppings", min: 0, max: 2, modifiers: [
  { id: `${id}-chocolate-sauce`, name: "Chocolate sauce", price: 40 },
  { id: `${id}-pistachio-crumb`, name: "Pistachio crumb", price: 80 },
] });
const sample = [
  { id: "latte", categoryId: "coffee", name: "Caffè latte", description: "Double espresso with your choice of milk, size, temperature and extras.", price: 360, groups: [size("latte"), milk("latte"), temperature("latte"), extras("latte")] },
  { id: "cappuccino", categoryId: "coffee", name: "Cappuccino", description: "Hot double espresso with silky milk foam.", price: 350, groups: [size("cappuccino"), milk("cappuccino"), extras("cappuccino")] },
  { id: "americano", categoryId: "coffee", name: "Americano", description: "Double espresso lengthened with water. Hot or iced.", price: 290, groups: [size("americano"), temperature("americano"), extras("americano")] },
  { id: "chai-latte", categoryId: "specialty", name: "Spiced chai latte", description: "Black tea and warming spices with your choice of milk. Select sweetness and serve hot or iced.", price: 450, groups: [size("chai-latte"), milk("chai-latte"), temperature("chai-latte"), sweetness("chai-latte")] },
  { id: "matcha-latte", categoryId: "specialty", name: "Matcha latte", description: "Stone-ground green tea whisked with your choice of milk, served hot or iced.", price: 480, groups: [size("matcha-latte"), milk("matcha-latte"), temperature("matcha-latte"), sweetness("matcha-latte")] },
  { id: "gelato-two", categoryId: "gelato", name: "Two-scoop gelato", description: "Two scoops of small-batch gelato. Choose flavours, cup or cone, and optional toppings.", price: 480, groups: [flavours("gelato-two", 2), serving("gelato-two"), toppings("gelato-two")] },
  { id: "gelato-one", categoryId: "gelato", name: "One-scoop gelato", description: "One scoop of small-batch gelato, in a cup or waffle cone.", price: 320, groups: [flavours("gelato-one", 1), serving("gelato-one"), toppings("gelato-one")] },
  { id: "panini", categoryId: "food", name: "Mozzarella & tomato panini", description: "Toasted sourdough panini with mozzarella, tomato and basil.", price: 720, groups: [
    { id: "panini-extras", name: "Panini extras", min: 0, max: 2, modifiers: [
      { id: "panini-pesto", name: "Basil pesto", price: 60 }, { id: "panini-avocado", name: "Avocado", price: 120 },
    ] },
  ] },
  { id: "avocado-toast", categoryId: "food", name: "Avocado toast", description: "Smashed avocado and lemon on your choice of toast, with optional poached eggs.", price: 680, groups: [
    { id: "avocado-toast-bread", name: "Choose bread", min: 1, max: 1, modifiers: [
      { id: "avocado-toast-sourdough", name: "Sourdough", price: 0 }, { id: "avocado-toast-seeded", name: "Seeded bread", price: 40 },
    ] },
    { id: "avocado-toast-extras", name: "Add extras", min: 0, max: 2, modifiers: [
      { id: "avocado-toast-egg", name: "Poached egg", price: 150, maxQuantity: 2 },
    ] },
  ] },
  { id: "croissant", categoryId: "pastry", name: "Butter croissant", description: "Flaky, all-butter pastry baked fresh. Ask staff about ingredients and allergens.", price: 260, groups: [
    { id: "croissant-extras", name: "Pastry extras", min: 0, max: 1, modifiers: [
      { id: "croissant-jam", name: "Strawberry jam", price: 50 },
    ] },
  ] },
  { id: "brownie", categoryId: "pastry", name: "Chocolate brownie", description: "Rich chocolate brownie. Ask staff about ingredient and allergen information.", price: 340, groups: [] },
];

export async function seed() {
  requireMockMode();
  const id = locationId();
  await db.location.upsert({ where: { id }, update: { timeZone: "America/Chicago" }, create: { id, name: "Yafi Café & Gelato", timeZone: "America/Chicago" } });
  const tax = { name: "Demo sales tax — illustrative, not a jurisdiction rate", bps: 1000 };
  await db.taxRate.upsert({ where: { id: "standard" }, update: tax, create: { id: "standard", ...tax } });
  for (const [categoryId, name] of [["coffee", "Coffee"], ["specialty", "Chai & matcha"], ["gelato", "Gelato"], ["pastry", "Pastry"], ["food", "Food"]]) {
    await db.category.upsert({ where: { id: categoryId }, update: { name }, create: { id: categoryId, locationId: id, name } });
  }
  for (const product of sample) {
    const { groups, ...data } = product;
    await db.product.upsert({ where: { id: product.id }, update: { ...data, version: 2 },
      create: { ...data, version: 2, locationId: id, cloverId: `mock_item_${product.id}`, taxId: "standard" } });
    for (const group of groups) {
      const { modifiers, ...groupData } = group;
      await db.modifierGroup.upsert({ where: { id: group.id }, update: {}, create: { ...groupData, productId: product.id } });
      for (const modifier of modifiers) {
        await db.modifier.upsert({ where: { id: modifier.id }, update: {},
          create: { ...modifier, groupId: group.id, cloverId: `mock_modifier_${modifier.id}` } });
      }
    }
  }
  await db.promotion.upsert({ where: { locationId_code: { locationId: id, code: "WELCOME10" } }, update: {},
    create: { locationId: id, code: "WELCOME10", percentBps: 1000, limit: 100 } });
  const now = Date.now();
  const first = Math.ceil((now + 15 * 60000) / (15 * 60000)) * (15 * 60000);
  for (let index = 0; index < 32; index++) {
    const startsAt = new Date(first + index * 15 * 60000);
    await db.slot.upsert({ where: { locationId_startsAt: { locationId: id, startsAt } }, update: {},
      create: { locationId: id, startsAt, capacity: 8 } });
  }
}

if (process.argv[1]?.endsWith("seed.ts")) {
  seed().then(() => console.info("Mock catalog and collection slots seeded.")).catch(() => {
    console.error("SEED_FAILED"); process.exitCode = 1;
  }).finally(() => db.$disconnect());
}
