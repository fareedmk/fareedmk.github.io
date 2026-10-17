"use client";

import { useEffect, useState } from "react";
import { money, request } from "./api-client";

type PublicOrder = {
  id?: string; reference?: string; paymentState: string; fulfillmentState: string; integrationState: string;
  total?: number; totalAmount?: number; pickupAt?: string; timeZone?: string;
  items?: { name: string; quantity: number }[];
  pricing?: { total: number };
  slot?: { startsAt: string };
};

export default function Tracking({ token }: { token: string }) {
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const update = () => request<PublicOrder>(`/api/orders/${encodeURIComponent(token)}`)
      .then(value => {
        if (active) {
          setOrder(value); setError("");
          if (["PAID", "FAILED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(value.paymentState)) {
            try {
              const stored = JSON.parse(localStorage.getItem("yafi.pending.v1") ?? "null");
              if (stored?.trackingToken === token) localStorage.removeItem("yafi.pending.v1");
            } catch { /* Optional recovery state is private to this browser. */ }
          }
        }
      })
      .catch(e => { if (active) setError(e.message); });
    void update(); const timer = setInterval(update, 4000);
    return () => { active = false; clearInterval(timer); };
  }, [token]);
  const pending = order && ["UNPAID", "PROCESSING", "UNKNOWN_REQUIRES_RECONCILIATION"].includes(order.paymentState);
  return <main className="tracking-shell"><a href="/" className="brand-name">YaFI</a>
    <section className="tracking-card" aria-live="polite">
      <p className="eyebrow">MOCK ORDER · NO REAL CHARGE</p>
      <h1>{!order ? "Finding your little joy…" : pending ? "We’re checking your payment." : order.paymentState === "FAILED" ? "Payment was not completed." : order.fulfillmentState === "READY" ? "Your little joy is ready." : "Thanks for stopping by."}</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {order && <>
        <p className="muted">Reference: {order.reference ?? order.id}</p>
        <div className="state-badges"><span>{order.paymentState}</span><span>{order.fulfillmentState}</span></div>
        {pending && <p className="notice">Please don’t pay again. We’re reconciling the original attempt. You can return to this private link to check progress.</p>}
        {order.paymentState === "FAILED" && <p className="notice">No successful payment was confirmed. This does not automatically cancel an independently paid order.</p>}
        {order.fulfillmentState === "SUBMITTED" && <p>Your order has been received and is waiting for staff acceptance. It is not ready yet.</p>}
        {order.fulfillmentState === "ACCEPTED" && <p>The café has accepted your order.</p>}
        {order.fulfillmentState === "PREPARING" && <p>Our team is preparing your order.</p>}
        {order.fulfillmentState === "READY" && <p>Please see our team at the pickup counter.</p>}
        {["PARTIALLY_REFUNDED", "REFUNDED"].includes(order.paymentState) && <p>A provider refund has been recorded. This mock refund does not move real money.</p>}
        {(order.pickupAt ?? order.slot?.startsAt) && <p className="muted">Pickup: {new Date((order.pickupAt ?? order.slot?.startsAt)!).toLocaleString("en-US", { timeZone: order.timeZone ?? "America/Chicago" })} ({order.timeZone ?? "America/Chicago"})</p>}
        {!!order.items?.length && <ul>{order.items.map((item, i) => <li key={i}>{item.quantity} × {item.name}</li>)}</ul>}
        <div className="price-row"><span>Total</span><strong>{money(order.pricing?.total ?? order.total ?? order.totalAmount ?? 0)}</strong></div>
        <p className="fine">Keep this link private; anyone with it can view this order’s status. Contact staff to revoke it. Transactional notifications are simulated locally.</p>
        <a href="/" className="button wide">Back to the menu <span>→</span></a>
      </>}
    </section>
  </main>;
}
