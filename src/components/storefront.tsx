"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { CartLine, Product } from "@/domain";
import { ApiError, money, request } from "./api-client";
import ProductArt from "./product-art";

type Menu = {
  mode: string;
  location: { id: string; name: string; timeZone: string; paused: boolean };
  categories: { id: string; name: string }[];
  products: (Product & { allergens?: string[]; dietary?: string[] })[];
};
type Slot = { id: string; startsAt: string; remaining: number };
type Quote = { id: string; token: string; expiresAt: string; pricing: {
  subtotal: number; modifierTotal: number; discount: number; tax: number; tip: number; total: number;
} };
type Selection = { modifierId: string; quantity: number };
const CART_KEY = "yafi.cart.v1";
const PENDING_KEY = "yafi.pending.v1";
const PRE_ORDER_REJECTIONS = ["QUOTE_EXPIRED", "PRICE_CHANGED", "AVAILABILITY_CHANGED", "QUOTE_CHANGED", "MENU_CHANGED", "PROMOTION_UNAVAILABLE", "ORDERING_PAUSED", "SLOT_UNAVAILABLE"];
const pendingSchema = z.object({ quoteId: z.string(), idempotencyKey: z.string(), mockScenario: z.string(), trackingToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const savedCartSchema = z.array(z.object({
  productId: z.string(), quantity: z.number().int().min(1).max(20),
  modifiers: z.array(z.object({ modifierId: z.string(), quantity: z.number().int().min(1).max(10) })).max(20),
  instructions: z.string().max(300).optional(),
})).max(30);

function ItemDialog({ product, onClose, onAdd }: {
  product: Product; onClose: () => void; onAdd: (line: CartLine) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selections, setSelections] = useState<Selection[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  const extras = selections.reduce((sum, selected) => {
    const modifier = product.groups.flatMap(g => g.modifiers).find(m => m.id === selected.modifierId);
    return sum + (modifier?.price ?? 0) * selected.quantity;
  }, 0);
  function add(event: FormEvent) {
    event.preventDefault();
    for (const group of product.groups) {
      const count = selections.filter(s => group.modifiers.some(m => m.id === s.modifierId))
        .reduce((n, s) => n + s.quantity, 0);
      if (count < group.min || count > group.max) {
        setError(`Choose ${group.min === group.max ? group.min : `${group.min}–${group.max}`} from ${group.name}.`);
        return;
      }
    }
    onAdd({ productId: product.id, quantity, modifiers: selections, instructions });
    onClose();
  }
  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="item-title">
    <button className="close" onClick={onClose} aria-label="Close item details">×</button>
    <div className="dialog-art"><ProductArt name={product.name} /></div>
    <form onSubmit={add} className="dialog-body">
      <p className="eyebrow">MAKE IT YOURS</p>
      <h2 id="item-title">{product.name}</h2><p className="muted">{product.description}</p>
      {product.groups.map(group => <fieldset key={group.id}>
        <legend>{group.name} <small>{group.min ? "Required" : "Optional"} · {group.min}–{group.max} selections</small></legend>
        {group.modifiers.map(modifier => {
          const selected = selections.find(s => s.modifierId === modifier.id);
          return <label className="modifier" key={modifier.id}>
            <input type={group.max === 1 ? "radio" : "checkbox"} name={group.id}
              disabled={!modifier.available} checked={!!selected}
              onChange={event => setSelections(current => {
                const rest = current.filter(s => s.modifierId !== modifier.id &&
                  !(group.max === 1 && group.modifiers.some(m => m.id === s.modifierId)));
                return event.target.checked ? [...rest, { modifierId: modifier.id, quantity: 1 }] : rest;
              })} />
            <span>{modifier.name}{!modifier.available && " · unavailable"}</span>
            <span>{modifier.price ? `+${money(modifier.price)}` : "Included"}</span>
            {!!selected && modifier.maxQuantity > 1 && <select aria-label={`${modifier.name} quantity`}
              value={selected.quantity} onChange={event => setSelections(current => current.map(s =>
                s.modifierId === modifier.id ? { ...s, quantity: Number(event.target.value) } : s))}>
              {Array.from({ length: modifier.maxQuantity }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
            </select>}
          </label>;
        })}
        {group.min === 0 && <button className="text-button" type="button" onClick={() =>
          setSelections(current => current.filter(s => !group.modifiers.some(m => m.id === s.modifierId)))}>Clear {group.name.toLowerCase()}</button>}
      </fieldset>)}
      <label>Special instructions <textarea value={instructions} onChange={e => setInstructions(e.target.value)}
        maxLength={300} placeholder="Anything we should know? No priced add-ons here." /></label>
      <p className="fine">Please tell us about allergies directly. We cannot guarantee an allergen-free environment.</p>
      <label>Quantity <input type="number" min="1" max="20" value={quantity}
        onChange={e => setQuantity(Number(e.target.value))} required /></label>
      {error && <p role="alert" className="error">{error}</p>}
      <button className="button wide" type="submit">Add to bag <span>{money((product.price + extras) * quantity)}</span></button>
    </form>
  </dialog>;
}

export default function Storefront() {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [error, setError] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Product | null>(null);
  const [checkout, setCheckout] = useState(false);
  const [offline, setOffline] = useState(false);
  const [pending, setPending] = useState<z.infer<typeof pendingSchema> | null>(null);
  useEffect(() => {
    request<Menu>("/api/menu").then(setMenu).catch(e => setError(e.message));
    try {
      const saved = savedCartSchema.safeParse(JSON.parse(localStorage.getItem(CART_KEY) ?? "[]"));
      if (saved.success) setCart(saved.data);
      const recovery = pendingSchema.safeParse(JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null"));
      if (recovery.success) setPending(recovery.data);
    } catch { /* Storage may be unavailable in private browsing. Ordering still works without persistence. */ }
    setLoaded(true);
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  useEffect(() => {
    if (loaded) { try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* Optional device persistence. */ } }
  }, [cart, loaded]);
  const count = cart.reduce((n, line) => n + line.quantity, 0);
  const estimated = cart.reduce((total, line) => {
    const product = menu?.products.find(p => p.id === line.productId);
    const extras = line.modifiers.reduce((sum, selection) => sum +
      (product?.groups.flatMap(g => g.modifiers).find(m => m.id === selection.modifierId)?.price ?? 0) * selection.quantity, 0);
    return total + ((product?.price ?? 0) + extras) * line.quantity;
  }, 0);
  const products = menu?.products.filter(p => (category === "all" || p.categoryId === category) &&
    `${p.name} ${p.description}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <>
    <div className="demo-banner">DEVELOPMENT STOREFRONT · Simulated orders & payments only. No real charges.</div>
    <header className="site-header">
      <a href="/" className="brand" aria-label="YaFI home">{process.env.NEXT_PUBLIC_LOGO_PATH && <img src={process.env.NEXT_PUBLIC_LOGO_PATH} width="44" height="44" alt="" />}<span className="brand-name">{process.env.NEXT_PUBLIC_BUSINESS_NAME ?? "YaFI"}</span><span>COFFEE & GELATO</span></a>
      <nav aria-label="Main navigation"><a href="#menu">Our menu</a><a href="#our-story">Our story</a><a href="/admin">Staff</a></nav>
      <button className="bag-button" onClick={() => document.getElementById("bag")?.scrollIntoView({ behavior: "smooth" })}>Your bag <span>{count}</span></button>
    </header>
    <main>
      <section className="hero">
        <div className="hero-copy"><p className="eyebrow">GOOD COFFEE. GREAT COMPANY.</p>
          <h1>Your everyday,<br /><em>a little sweeter.</em></h1>
          <p>Thoughtfully crafted coffee, a taste of home, and gelato worth slowing down for. Your next little joy is here.</p>
          <a href="#menu" className="button">Find your favorite <span aria-hidden="true">↗</span></a>
          <div className="hero-details"><span>✦ Crafted with care</span><span>♡ Made for your neighborhood</span></div>
        </div>
        <div className="hero-art" aria-hidden="true"><div className="hero-circle" /><ProductArt name="Coffee" /><span className="art-sticker">SIP. SCOOP.<br />SMILE.</span><span className="art-caption">a little cup of happy</span></div>
      </section>
      <div className="pickup-strip"><span className="status-dot" /><strong>Made fresh. Picked up by you.</strong><span>{menu?.location.name ?? "YaFI café"} · {menu?.location.timeZone ?? "America/Chicago"}</span><span className="pickup-label">PICKUP ONLY</span></div>
      {offline && <p className="notice" role="status">You’re offline. Keep this page open and reconnect before checking out.</p>}
      {pending && <section className="notice" aria-label="Payment recovery">
        <strong>An earlier payment may still be processing.</strong> Do not start another order for the same purchase.{" "}
        <a className="text-button" href={`/orders/${pending.trackingToken}`}>Check original order</a>{" "}
        <button className="text-button" onClick={async () => {
          try {
            await request("/api/checkout", { quoteId: pending.quoteId, idempotencyKey: pending.idempotencyKey, mockScenario: pending.mockScenario });
            window.location.assign(`/orders/${pending.trackingToken}`);
          } catch (e) {
            if (e instanceof ApiError && PRE_ORDER_REJECTIONS.includes(e.code)) {
              try { localStorage.removeItem(PENDING_KEY); } catch { /* Optional device persistence. */ }
              setPending(null);
              setError(`${e.message} No order was created by this submission. Review a new quote.`);
            } else setError((e as Error).message);
          }
        }}>Retry original submission safely</button>
      </section>}
      {menu?.location.paused && <p className="notice" role="status">Online ordering is paused. You can still browse the menu.</p>}
      <section id="menu" className="menu-section">
        <div className="section-heading"><div><p className="eyebrow">FIND YOUR HAPPY PLACE</p><h2>A menu full of little joys.</h2></div>
          <label className="search"><span className="sr-only">Search menu</span><input type="search" placeholder="Search something delicious…" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
        <div className="category-nav" aria-label="Menu categories">
          {[{ id: "all", name: "All favorites" }, ...(menu?.categories ?? [])].map(c =>
            <button key={c.id} aria-pressed={category === c.id} className={category === c.id ? "active" : ""} onClick={() => setCategory(c.id)}>{c.name}</button>)}
        </div>
        {error && <div role="alert" className="error">{error} <button onClick={() => window.location.reload()}>Try again</button></div>}
        {!menu && !error && <p role="status" className="loading">Brewing up the menu…</p>}
        <div className="ordering-layout">
          <div className="product-grid">
            {products.map((p, index) => <article className="product-card" key={p.id}>
              <div className={`product-image tone-${index % 4}`}><ProductArt name={p.name} category={menu?.categories.find(c => c.id === p.categoryId)?.name} />
                {index === 0 && <span className="tag">HOUSE FAVORITE</span>}{!p.available && <span className="tag sold-out">SOLD OUT</span>}</div>
              <div className="product-copy"><h3>{p.name}</h3><p>{p.description}</p>
                {!!p.allergens?.length && <p className="fine">Contains: {p.allergens.join(", ")}</p>}
                <div className="product-bottom"><strong>{money(p.price)}</strong><button disabled={!p.available || menu?.location.paused} onClick={() => setSelected(p)} aria-label={`Customize ${p.name}`}>＋</button></div></div>
            </article>)}
            {menu && products.length === 0 && <p className="empty">No matches yet. Try another category or search.</p>}
          </div>
          <aside className="cart" id="bag" aria-labelledby="bag-heading">
            <div className="cart-heading"><h2 id="bag-heading">Your little joys</h2><span>{count}</span></div>
            <p className="fine">Freshly prepared for café pickup</p>
            {!cart.length && <div className="empty-bag"><span aria-hidden="true">♧</span><h3>Good things go in here.</h3><p>Add a favorite and make it yours.</p></div>}
            {cart.map((line, index) => {
              const p = menu?.products.find(p => p.id === line.productId);
              return <div className="cart-line" key={index}><strong>{line.quantity} × {p?.name ?? "Unavailable item"}</strong>
                <p>{line.modifiers.map(s => p?.groups.flatMap(g => g.modifiers).find(m => m.id === s.modifierId)?.name).filter(Boolean).join(", ")}</p>
                <button className="text-button" onClick={() => setCart(current => current.filter((_, i) => i !== index))}>Remove <span className="sr-only">{p?.name}</span></button></div>;
            })}
            {!!cart.length && <><div className="price-row"><span>Subtotal estimate</span><strong>{money(estimated)}</strong></div>
              <p className="fine">Taxes, discounts, and optional tip calculated at checkout.</p>
              <button className="button wide" disabled={offline || menu?.location.paused || !!pending} onClick={() => setCheckout(true)}>Review checkout <span>→</span></button></>}
            <p className="cart-footnote">A little care in every order.</p>
          </aside>
        </div>
      </section>
      <section id="our-story" className="story"><p className="eyebrow">MORE THAN A COFFEE STOP</p><h2>A place to pause.<br />A flavor to come back to.</h2><p>From comforting chai to your favorite scoop, we believe the best moments are the simple ones shared together.</p><span>With love, YaFI.</span></section>
    </main>
    <footer><a href="/" className="brand-name">YaFI</a><p>Coffee. Gelato. A little joy.</p><p>Menu illustrations are representative. Ask our team about ingredients and allergens.</p><a href="/admin">Staff sign in</a></footer>
    {selected && <ItemDialog product={selected} onClose={() => setSelected(null)} onAdd={line => setCart(current => [...current, line])} />}
    {checkout && menu && <Checkout cart={cart} timeZone={menu.location.timeZone} onClose={() => setCheckout(false)} />}
  </>;
}

function Checkout({ cart, timeZone, onClose }: { cart: CartLine[]; timeZone: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const key = useRef<string>("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [scenario, setScenario] = useState("SUCCESS");
  const [attempted, setAttempted] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    request<{ slots: Slot[] }>("/api/slots").then(r => setSlots(r.slots)).catch(e => setError(e.message));
  }, []);
  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      const result = await request<Quote>("/api/quotes", {
        lines: cart, tip: Number(data.get("tip") ?? 0), code: String(data.get("code") ?? "") || undefined,
        slotId: data.get("slotId"), instructions: data.get("instructions"),
        customer: {
          name: data.get("name"), email: data.get("email"), phone: data.get("phone"),
          recipientName: String(data.get("recipientName") ?? "") || undefined,
          recipientPhone: String(data.get("recipientPhone") ?? "") || undefined,
          marketingConsent: data.get("marketingConsent") === "on",
        },
      });
      key.current = crypto.randomUUID(); setQuote(result);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function pay() {
    if (!quote) return;
    if (!attempted && new Date(quote.expiresAt).getTime() <= Date.now()) { setError("This quote expired. Review a new quote before paying."); setQuote(null); return; }
    setError(""); setBusy(true);
    setAttempted(true);
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({
        quoteId: quote.id, idempotencyKey: key.current, mockScenario: scenario, trackingToken: quote.token,
      }));
    } catch { /* The original key remains in this dialog when storage is unavailable. */ }
    try {
      const result = await request<{ trackingToken: string }>("/api/checkout", {
        quoteId: quote.id, idempotencyKey: key.current, mockScenario: scenario,
      });
      if (!result.trackingToken) throw new Error("No tracking reference returned. Do not start another payment; contact staff.");
      try { localStorage.removeItem(CART_KEY); } catch { /* Optional device persistence. */ }
      window.location.assign(`/orders/${encodeURIComponent(result.trackingToken)}`);
    } catch (e) {
      if (e instanceof ApiError && PRE_ORDER_REJECTIONS.includes(e.code)) {
        setAttempted(false); setQuote(null);
        try { localStorage.removeItem(PENDING_KEY); } catch { /* Optional device persistence. */ }
        setError(`${e.message} Review a fresh quote before submitting again.`);
      } else {
        setError(`${(e as Error).message} Retry uses the same payment reference; do not start a new checkout.`);
      }
      setBusy(false);
    }
  }
  return <dialog ref={dialog} onCancel={event => { if (busy || attempted) event.preventDefault(); else onClose(); }} aria-labelledby="checkout-title">
    <button className="close" onClick={onClose} disabled={busy || attempted} aria-label="Close checkout">×</button>
    <div className="dialog-body checkout-body"><p className="eyebrow">ONE MORE LITTLE THING</p><h2 id="checkout-title">Your café pickup.</h2>
      <p className="notice">MOCK CHECKOUT — no card details, no real payment, no order sent to Clover.</p>
      <form ref={formRef} onSubmit={review} onChange={() => { if (quote && !busy) setQuote(null); }}>
        <fieldset disabled={busy || !!quote}><legend>Who’s ordering?</legend>
          <label>Your name<input name="name" autoComplete="name" required maxLength={100} /></label>
          <label>Email<input type="email" name="email" autoComplete="email" required maxLength={254} /></label>
          <label>Contact number<input name="phone" type="tel" autoComplete="tel" required maxLength={32} placeholder="+44 20 7946 0000" /></label>
          <p className="fine">International numbers welcome. Used for this order, not marketing.</p>
          <label>Pickup recipient, if different<input name="recipientName" maxLength={100} /></label>
          <label>Recipient contact (optional)<input name="recipientPhone" type="tel" maxLength={32} /></label>
        </fieldset>
        <fieldset disabled={busy || !!quote}><legend>When should we expect you?</legend>
          <label>Pickup time ({timeZone})<select name="slotId" required defaultValue=""><option value="" disabled>Choose an available pickup time</option>
            {slots.map((slot, i) => <option key={slot.id} value={slot.id} disabled={slot.remaining < 1}>
              {i === 0 ? "ASAP · " : ""}{new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(slot.startsAt))} · {slot.remaining} left
            </option>)}</select></label>
          {!slots.length && <p role="status">No pickup slots available. Ordering may be closed or at capacity.</p>}
          <label>Order instructions<textarea name="instructions" maxLength={300} /></label>
          <label>Promotion code<input name="code" maxLength={40} placeholder="Try WELCOME10 in mock mode" /></label>
          <label>Optional tip<select name="tip" defaultValue="0"><option value="0">No tip</option><option value="100">$1.00</option><option value="200">$2.00</option><option value="300">$3.00</option></select></label>
          <label className="check-label"><input name="marketingConsent" type="checkbox" />Send me occasional YaFI news (optional).</label>
        </fieldset>
        {!quote && <button className="button wide" disabled={busy || !slots.length} type="submit">{busy ? "Validating your order…" : "Get current total"}</button>}
      </form>
      {quote && <section aria-label="Authoritative quote" className="quote">
        <h3>Review your total</h3>
        {[["Items", quote.pricing.subtotal - quote.pricing.modifierTotal], ["Modifiers", quote.pricing.modifierTotal], ["Discount", -quote.pricing.discount], ["Tax", quote.pricing.tax], ["Service charge", 0], ["Tip", quote.pricing.tip], ["Total", quote.pricing.total]].map(([label, value]) =>
          <div className="price-row" key={label}><span>{label}</span><strong>{money(Number(value))}</strong></div>)}
        <p className="fine">This price is reserved until {new Date(quote.expiresAt).toLocaleTimeString()}. If anything changes, you must review a new quote.</p>
        <label>Mock payment scenario<select disabled={busy || attempted} value={scenario} onChange={e => setScenario(e.target.value)}>
          <option value="SUCCESS">Approved simulation</option><option value="DECLINE">Declined simulation</option>
          <option value="TIMEOUT_AFTER_SUCCESS">Successful charge, response lost</option><option value="OUTAGE">Provider outage</option>
          <option value="PRINT_UNAVAILABLE">Printer unavailable</option>
        </select></label>
        <button className="button wide" disabled={busy} onClick={pay}>{busy ? "Submitting safely…" : `Accept & simulate ${money(quote.pricing.total)}`}</button>
        <button className="text-button" disabled={busy || attempted} onClick={() => setQuote(null)}>Change details / refresh quote</button>
        {attempted && <a href={`/orders/${quote.token}`} className="text-button">Check original payment status</a>}
      </section>}
      {error && <p role="alert" className="error">{error}</p>}
      <p className="fine">Order received does not mean accepted or ready. Wallets, gift cards, rewards, saved cards, and real payments are not enabled.</p>
    </div>
  </dialog>;
}
