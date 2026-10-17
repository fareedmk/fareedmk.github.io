# YaFI Coffee & Gelato

An executable **Phase 1 ordering foundation**, not a production-ready Clover deployment.
Real payments, OAuth, webhooks, and native Clover printing are deliberately disabled.
`CLOVER_MODE=sandbox|production` fails closed.

## Start locally

Requires Node **22.12+ (22.x)**, npm, and PostgreSQL 17 or Docker.

1. Copy `.env.example` to `.env`. Generate a URL-safe database password and an independent owner password of at least 12 characters.
2. Set `POSTGRES_PASSWORD`, `ADMIN_PASSWORD`, and `DATABASE_URL`. The local PostgreSQL connection uses username `yafi`, your generated database password, host `localhost`, port `5432`, database `yafi`, and schema `public`. Never use a production database for tests.
3. Keep `CLOVER_MODE=mock` and `APP_ORIGIN=http://localhost:3000`.

```sh
npm ci
docker compose up -d db
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

In another terminal, run `npm run worker`. Both Next.js development and the worker load `.env`. Visit `http://localhost:3000`; staff sign in at `/admin`. No card number or Clover credential is needed.

For the containerized application:

```sh
docker compose up --build -d
docker compose run --rm migrate npm run db:seed
docker compose logs -f web worker
```

Compose overrides the database hostname to `db`. The database port is bound only to localhost. Generate URL-safe passwords (for example hexadecimal) to avoid connection-string encoding issues. Seeding is explicit and **mock-only**, not a production release step. `docker compose down` retains the database volume; `down -v` destroys it.

## Working slice

- Mobile-first branded menu, search/categories, SVG product illustrations, native accessible customization dialogs, persistent bag, guest checkout, and purchaser/recipient separation.
- Server-authoritative integer pricing, required/quantity-constrained modifiers, allocated discounts/taxes, expiring quotes, transactional pickup/promotion capacity, and checkout revalidation.
- Durable mock order/payment/refund references, idempotent checkout, worker leases, backoff/dead letters, original-attempt reconciliation, and explicit print-request evidence.
- Private revocable tracking links and an authenticated owner queue with fulfillment controls, refunds, manual print requests, pause, slot capacity, percentage codes, and integration exceptions.
- PostgreSQL Prisma schema, SQL migration, seed data, unit/integration/browser tests, Docker setup, and operational documentation.

Mock scenarios: approved, decline, provider outage, successful charge with response lost, and unavailable printer. No mock result represents real money or delivery to Clover. Printing is a separate manual request; a payment scenario does not silently print an immediate scheduled-order ticket.

## Verification commands

```sh
npm run lint
npm run typecheck
npm test -- tests/unit
# Uses and resets test-owned records. Use a dedicated migrated PostgreSQL test database:
npm test -- tests/integration
npx playwright install chromium
npm run test:e2e
npm run build
npm audit
```

Integration tests require `DATABASE_URL` and mock mode; read their setup before execution. Browser tests require a freshly seeded mock database with future slots. Start the worker to advance submitted orders. The browser suite is a targeted subset, **not** all requested production acceptance scenarios.

## Repository structure

```text
src/app/             Storefront, staff and tracking pages; application API routes
src/components/      Browser UI and same-origin API client
src/domain/          Money, modifiers, promotions, tax, scheduling, states, refunds
src/server/          Runtime schemas, catalog, quote/order transactions, auth
src/adapters/        Typed provider contracts and persistent mock provider
src/worker/          PostgreSQL outbox claims and durable orchestration
prisma/              Relational schema, SQL migration, seed menu
tests/               Unit, PostgreSQL integration, mobile browser tests
docs/                Capability audit, Mermaid diagrams, API and operations
```

## Architecture and integration evidence

- [Clover capability matrix](docs/clover-capability-matrix.md): official source URLs, permissions/prerequisites, evidence gaps, and fallbacks.
- [Architecture diagram](docs/architecture.mmd) and [checkout/failure sequence](docs/checkout-sequence.mmd).
- [Application API reference](docs/api.yaml).
- [Operations](docs/operations.txt): architecture decisions, Azure requirements/cost drivers, onboarding/device checklists, refunds/reconciliation, backups, credential rotation, and production gates.

Official Clover pages could not be retrieved during the audit because DNS resolution failed. **No sandbox verification is claimed.** Search-index descriptions were insufficient to safely choose an existing-atomic-order payment versus Hosted Checkout contract. Live work requires readable current official schemas, merchant authorization, and a recorded end-to-end sandbox demonstration. Do not invent API fields or combine unrelated payment APIs.

The independently hosted menu imposes no customer country restriction. This does **not** guarantee international card acceptance, override provider terms, or bypass regional restrictions.

## Explicit remaining scope

- Complete verified Clover OAuth/token lifecycle, encrypted secrets, inventory/category/modifier/tax import, pagination/reconciliation/webhook refresh, and authoritative financial mapping.
- Existing-order tokenization/payment/refund contract, challenge flows, real notification delivery, merchant POS/KDS/printing and delayed firing acceptance.
- Full normalized multi-merchant model and tenant RBAC, named Owner/Manager/Staff users, production MFA/OIDC, retention jobs and monitored external alerts.
- Full merchant promotions: persisted fixed/BOGO/item/category rules, automatic/manager offers, stacking, first-order identity policy, per-customer/single-use/day-time restrictions, imported native discounts and itemized refund persistence. Pure domain helpers are not the complete connected promotion feature.
- Configurable weekly hours/holiday overrides and continuously generated slots, max order policy, item-specific schedules, merchant allergen/dietary editor and remote product images. Seeded future slots are a local demonstration, not a live café schedule.
- Optional customer accounts, saved cards, wallets, loyalty, gift cards and pay-at-pickup are not enabled.
- Full requested failure E2E matrix and controlled real-money/device pilot.

The purchase snapshot preserves historical prices and modifier identities, but the schema is a Phase 1 subset, not all requested normalized entities. Current server routes scope the configured location; this is not proof of general multi-merchant readiness.

**GitHub Pages cannot host this backend.** Use a server/container platform plus PostgreSQL and a continuously running worker. Azure deployment incurs compute, database, storage, logging, network, and provider costs.