"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { money, request } from "./api-client";

type AdminOrder = {
  id: string; createdAt: string; paymentState: string; integrationState: string; fulfillmentState: string;
  total?: number; totalAmount?: number; customer?: { name?: string; recipientName?: string };
  snapshot?: unknown; pickupAt?: string; cloverOrderId?: string;
  pricing?: { total: number }; slot?: { startsAt: string };
};
type IntegrationHealth = { liveIntegration: string; intake: string; printing: string; deadLetters: { id: string; kind: string; aggregateId: string; lastError: string }[] };
type Promotion = { code: string; percentBps: number; limit: number; active: boolean };
type AdminSlot = { id: string; startsAt: string; capacity: number; reserved: number };

export default function Admin() {
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [health, setHealth] = useState<IntegrationHealth | null>(null);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [slots, setSlots] = useState<AdminSlot[]>([]);
  const refresh = useCallback(async () => {
    try {
      const result = await request<{ orders: AdminOrder[] }>("/api/admin/orders");
      setOrders(result.orders); setAuthenticated(true); setError("");
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const refreshSettings = useCallback(async () => {
    try {
      const [integration, rules, capacity] = await Promise.all([
        request<IntegrationHealth>("/api/admin/integration"),
        request<{ promotions: Promotion[] }>("/api/admin/promotions"),
        request<{ slots: AdminSlot[] }>("/api/admin/slots"),
      ]);
      setHealth(integration); setPromotions(rules.promotions); setSlots(capacity.slots);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { if (authenticated) void refreshSettings(); }, [authenticated, refreshSettings]);
  async function save(path: string, payload: unknown) {
    setBusy(true); setError("");
    try {
      await request(path, payload); setMessage("Setting saved and audited."); await refreshSettings();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = event.currentTarget;
    try {
      await request("/api/admin/session", { password: new FormData(form).get("password") });
      form.reset(); await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function action(id: string, kind: string, payload: unknown) {
    setBusy(true); setError(""); setMessage("");
    try {
      await request(`/api/admin/orders/${encodeURIComponent(id)}/${kind}`, payload);
      setMessage(`${kind === "refund" ? "Refund operation" : kind === "reprint" ? "Print request (not physical print confirmation)" : "Status update"} recorded.`);
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="admin-shell">
    <a href="/" className="brand-name">YaFI</a>
    <p className="eyebrow">STAFF WORKSPACE · MOCK MODE</p><h1>A little care, behind the counter.</h1>
    <p className="muted">Paid does not mean accepted. This is the Phase 1 staff intake queue, not a native Clover device workflow.</p>
    {!authenticated ? <form className="admin-login" onSubmit={login}>
      <h2>Staff sign in</h2><p className="fine">Use the owner password configured on the server. There is no default password.</p>
      <label>Password<input type="password" name="password" autoComplete="current-password" required minLength={12} /></label>
      <button className="button wide" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form> : <>
      <div className="admin-toolbar"><label>Find an order<input type="search" placeholder="Order reference or state" value={filter} onChange={e => setFilter(e.target.value)} /></label>
        <button className="button" onClick={refresh} disabled={busy}>Refresh queue</button>
        <button className="text-button" onClick={async () => {
          try { await request("/api/admin/session", undefined, "DELETE"); setAuthenticated(false); setOrders([]); }
          catch (e) { setError((e as Error).message); }
        }}>Sign out</button></div>
      <details className="admin-order"><summary>Integration health & café controls</summary>
        <p className="muted">Live integration: {health?.liveIntegration ?? "Loading…"} · Intake: {health?.intake} · Print evidence: {health?.printing}</p>
        <div className="admin-actions">
          <button className="button" disabled={busy} onClick={() => {
            if (window.confirm("Pause new online orders? Existing paid orders are preserved.")) void save("/api/admin/location", { paused: true });
          }}>Pause ordering</button>
          <button className="button" disabled={busy} onClick={() => save("/api/admin/location", { paused: false })}>Resume ordering</button>
          <button className="text-button" disabled={busy} onClick={async () => {
            try { const result = await request<{ message: string }>("/api/admin/sync", {}); setMessage(result.message); }
            catch (e) { setError((e as Error).message); }
          }}>Inspect mock catalog (not Clover sync)</button>
        </div>
        <h3>Reconciliation exceptions</h3>
        {!health?.deadLetters.length && <p className="fine">No dead-letter jobs reported. This does not prove every external system is healthy.</p>}
        {health?.deadLetters.map(job => <p className="notice" key={job.id}>{job.kind} · {job.aggregateId} · {job.lastError}{" "}
          <button className="text-button" disabled={busy} onClick={() => {
            if (window.confirm("Retry the original durable operation after reviewing provider evidence? This will never authorize a new payment for an unknown attempt.")) void save(`/api/admin/jobs/${job.id}/retry`, { confirm: true });
          }}>Retry original operation</button></p>)}
        <form onSubmit={event => {
          event.preventDefault(); const data = new FormData(event.currentTarget);
          void save("/api/admin/slots", { slotId: data.get("slotId"), capacity: Number(data.get("capacity")) });
        }}><h3>Pickup capacity</h3>
          <label>Slot<select name="slotId" required>{slots.map(slot => <option key={slot.id} value={slot.id}>{new Date(slot.startsAt).toLocaleString("en-US", { timeZone: "America/Chicago" })} CT · {slot.reserved}/{slot.capacity} reserved</option>)}</select></label>
          <label>New capacity<input name="capacity" type="number" min="0" max="200" required /></label>
          <button className="button" disabled={busy || !slots.length}>Save capacity</button>
        </form>
      </details>
      <details className="admin-order"><summary>Promotion codes (percentage-only Phase 1)</summary>
        <p className="fine">One non-stacking code per order. Full-cart pre-tax eligibility, maximum global usage count. Not a native Clover promotion.</p>
        <ul>{promotions.map(p => <li key={p.code}>{p.code} · {p.percentBps / 100}% · limit {p.limit} · {p.active ? "Active" : "Disabled"}</li>)}</ul>
        <form onSubmit={event => {
          event.preventDefault(); const data = new FormData(event.currentTarget);
          void save("/api/admin/promotions", { code: String(data.get("code")).toUpperCase(), percent: Number(data.get("percent")), limit: Number(data.get("limit")), active: data.get("active") === "on" });
        }}>
          <label>Code (existing code updates it)<input name="code" pattern="[A-Za-z0-9_-]{3,32}" required maxLength={32} /></label>
          <label>Percentage<input name="percent" type="number" min="1" max="100" required /></label>
          <label>Total redemption limit<input name="limit" type="number" min="0" max="100000" required /></label>
          <label className="check-label"><input name="active" type="checkbox" defaultChecked />Active</label>
          <button className="button" disabled={busy}>Save promotion</button>
        </form>
      </details>
      <div className="admin-orders">{orders.filter(order => `${order.id} ${order.paymentState} ${order.fulfillmentState}`.toLowerCase().includes(filter.toLowerCase())).map(order =>
        <article className="admin-order" key={order.id}>
          <p className="eyebrow">ORDER {order.id}</p><h2>{order.customer?.recipientName ?? order.customer?.name ?? "Café pickup"}</h2>
          <div className="state-badges"><span>Payment: {order.paymentState}</span><span>Integration: {order.integrationState}</span><span>Fulfillment: {order.fulfillmentState}</span></div>
          <p>{money(order.pricing?.total ?? order.total ?? order.totalAmount ?? 0)} · Received {new Date(order.createdAt).toLocaleString("en-US", { timeZone: "America/Chicago" })} CT</p>
          {(order.pickupAt ?? order.slot?.startsAt) && <p>Pickup {new Date((order.pickupAt ?? order.slot?.startsAt)!).toLocaleString("en-US", { timeZone: "America/Chicago" })} CT</p>}
          <details><summary>Purchase snapshot</summary><pre>{JSON.stringify(order.snapshot ?? order, null, 2)}</pre></details>
          {order.paymentState === "UNKNOWN_REQUIRES_RECONCILIATION" && <p className="notice">Do not charge again. The worker must reconcile the original attempt.</p>}
          <div className="admin-actions">
            {(["SUBMITTED", "ACCEPTED", "PREPARING", "READY"] as string[]).includes(order.fulfillmentState) && order.paymentState === "PAID" &&
              <button className="button" disabled={busy} onClick={() => {
                const next: Record<string, string> = { SUBMITTED: "ACCEPTED", ACCEPTED: "PREPARING", PREPARING: "READY", READY: "COMPLETED" };
                void action(order.id, "status", { status: next[order.fulfillmentState] });
              }}>{({ SUBMITTED: "Accept order", ACCEPTED: "Start preparing", PREPARING: "Mark ready", READY: "Complete pickup" } as Record<string, string>)[order.fulfillmentState]}</button>}
            <button className="text-button" disabled={busy} onClick={() => {
              if (window.confirm("Request a manually labeled reprint? This can duplicate a preparation ticket. Provider acceptance is not physical print evidence.")) void action(order.id, "reprint", { confirm: true, idempotencyKey: crypto.randomUUID() });
            }}>Request manual reprint</button>
            {["PAID", "PARTIALLY_REFUNDED"].includes(order.paymentState) && <button className="text-button" disabled={busy} onClick={() => {
              const input = window.prompt("Refund amount in cents (for example 100 = $1.00). This invokes the mock payment provider, not just a local status change.");
              if (input === null) return;
              const amount = Number(input);
              if (!Number.isSafeInteger(amount) || amount <= 0) { setError("Enter a positive whole number of cents."); return; }
              if (window.confirm(`Confirm provider refund of ${money(amount)}?`)) void action(order.id, "refund", { amount, confirm: true, idempotencyKey: crypto.randomUUID() });
            }}>Refund…</button>}
          </div>
        </article>)}
        {!orders.length && <p className="empty">No orders yet. The queue will show orders after mock checkout.</p>}
      </div>
    </>}
    {error && <p role="alert" className="error">{error}</p>}
    {message && <p role="status" className="notice">{message}</p>}
  </main>;
}
