# Markee — Marketplace Platform

**Author:** Toluwalase Mebaanne  
**Course Context:** INFO 6250 — Web Development Tools & Methods  
**Type:** Backend architecture project delivered as a service-oriented monorepo  
**Stack:** Node.js · Express · MongoDB · EJS · JWT · EventBus · PM2 · Cloudflare Tunnel

---

## What This Is

Markee is a multi-vendor marketplace platform built to satisfy backend architecture goals for a web development course while still being implemented as a real working system. It covers the full lifecycle of a two-sided marketplace — buyers discovering and purchasing products, sellers managing inventory and storefronts, and operators running the platform through an admin control system.

The project is intentionally organized by service boundaries because the business problem is naturally split across domains such as auth, catalog, inventory, orders, payments, shipping, reviews, messaging, search, analytics, user profiles, seller storefronts, and admin operations.

At the same time, the current implementation deliberately runs all services in one Node.js process during development and demonstration. That choice is not accidental. It is how the platform preserves cross-service coordination through the shared in-process EventBus without introducing extra broker infrastructure that was outside the course scope.

This means the right way to describe Markee is:

- service-oriented in design
- monorepo in code organization
- single-process coordinated in runtime
- distributed in architectural thinking, but not yet broker-backed in deployment

That tradeoff was chosen consciously to demonstrate backend architecture patterns clearly within course constraints.

---

## How This Meets The Course Requirements

This project was shaped around the kinds of backend concerns the course emphasizes:

- **Node.js + Express** as the application runtime and framework
- **MongoDB + Mongoose** for persistence
- **EJS-rendered views** through the gateway instead of introducing an unnecessary frontend framework
- **Authentication and authorization** implemented in the backend with JWT, refresh tokens, scopes, and OAuth-style flows
- **Clear route, middleware, model, and service separation**
- **Inter-service communication** modeled through REST and asynchronous events
- **Backend architecture reasoning** around state transitions, operational controls, and domain boundaries

In other words, this is not just a CRUD store. It is a backend systems project where the main deliverable is the architecture itself: how services are separated, how they coordinate, how they enforce ownership, and how platform-wide state changes propagate safely.

---

## Why I Chose Coordinated Monolith Runtime Instead Of Fully Separate Service Processes

The most important architectural decision in this project is the distinction between logical service separation and runtime deployment style.

### What I kept

- separate services by business domain
- separate Express apps
- separate ports
- separate MongoDB ownership
- separate route surfaces
- explicit inter-service REST dependencies
- explicit async event flows

### What I did not add yet

- Redis pub/sub
- RabbitMQ / Kafka
- cross-process event transport
- container orchestration
- distributed tracing infrastructure

### Why

For this course, the goal was to demonstrate backend architecture clearly without spending the project's complexity budget on infrastructure plumbing that would not change the underlying domain design. A fully split runtime would have required introducing a real broker for events. Without that, the event-driven parts of the platform would break across process boundaries.

So instead of pretending the system was fully distributed when it was not, I chose a more honest and stable implementation:

- the services remain separate by responsibility
- the coordination layer remains event-driven
- all services run in one Node process through `start-monolith.js`
- the shared `EventBus` works correctly because the module singleton is truly shared

This preserves the architectural idea while keeping the system demonstrable, debuggable, and aligned with course scope.

### The tradeoff

The benefit is clear service design with low infrastructure overhead.

The limitation is also clear: this is not yet a production-grade distributed event system. If the platform were split into separate containers or hosts, `shared/eventBus.js` would need to be replaced by a real broker such as Redis pub/sub or RabbitMQ.

That limitation is known and documented in `foundational_docs/service_dependency_map.md`.

---

## Architecture Overview

```
                        ┌─────────────────────────────┐
                        │        API Gateway :4000     │
                        │   Rate limiting · JWT auth   │
                        │   Proxy routing · EJS views  │
                        └──────────────┬──────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
     ┌────────▼────────┐    ┌──────────▼──────────┐  ┌────────▼────────┐
     │  Auth :5001     │    │  Admin Service :5014  │  │  User :5002     │
     │  JWT · bcrypt   │    │  Superuser controls   │  │  Profiles       │
     │  Token refresh  │    │  Permission system    │  │  Role mgmt      │
     └─────────────────┘    └──────────┬────────────┘  └─────────────────┘
                                       │
                            ┌──────────▼──────────┐
                            │     EventBus         │
                            │  platform.lockdown   │
                            │  platform.maintenance│
                            │  order.* · payment.* │
                            └──────────┬───────────┘
                                       │
     ┌─────────────────────────────────┼──────────────────────────────────┐
     │              │              │              │              │          │
┌────▼───┐  ┌───────▼──┐  ┌───────▼──┐  ┌───────▼──┐  ┌───────▼──┐  ┌──▼──────┐
│Catalog │  │  Order   │  │ Payment  │  │  Seller  │  │Inventory │  │ Search  │
│ :5003  │  │  :5005   │  │  :5006   │  │  :5007   │  │  :5009   │  │  :5010  │
└────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └─────────┘
     │              │              │              │              │          │
┌────▼───┐  ┌───────▼──┐  ┌───────▼──┐  ┌───────▼──┐  ┌───────▼──┐
│Shipping│  │Messaging │  │  Review  │  │Notif.    │  │Analytics │
│ :5011  │  │  :5008   │  │  :5012   │  │  :5013   │  │  :5015   │
└────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘
```

**15 service boundaries. One monorepo. One shared process in dev/runtime coordination mode. Zero shared databases.**

---

## Services

| Service | Port | Responsibility |
|---|---|---|
| API Gateway | 4000 | Single entry point — rate limiting, JWT verification, proxy routing, admin UI rendering |
| Auth | 5001 | Registration, login, JWT issuance and refresh, token revocation |
| User | 5002 | Buyer/seller profiles, role management, account lifecycle |
| Catalog | 5003 | Product listings, categories, approval queue, featured products |
| Order | 5005 | Order lifecycle — placement through completion, status management |
| Payment | 5006 | Escrow hold/release, refunds, dispute resolution, payout holds |
| Seller | 5007 | Seller storefronts, tier system, verification, registration approval |
| Messaging | 5008 | Buyer-seller threads, dispute messages, system injection |
| Inventory | 5009 | Stock levels, reservations, adjustments, freeze controls |
| Search | 5010 | Product search, autocomplete, index health, reindexing |
| Shipping | 5011 | Shipment tracking, carrier status, stuck-in-transit detection |
| Review | 5012 | Buyer reviews, moderation queue, flagged content |
| Notification | 5013 | Email/push dispatch, templates, broadcast, delivery logs |
| Admin | 5014 | Permission system, platform controls, audit log, intelligence |
| Analytics | 5015 | GMV, revenue, top products, funnel metrics |

---

## Key Systems

### Two-Track Authentication

The platform runs two completely separate auth systems that never intersect:

- **User auth** — OAuth-style JWT tokens issued by Auth Service. Scoped to `catalog:read`, `orders:write`, etc. Refreshable.
- **Admin auth** — Separate JWT with `isAdmin: true`, `isSuperuser: bool`. Issued only by Admin Service after admin credential verification. Short-lived with session tracking in MongoDB.

A user token cannot access admin routes. An admin token cannot be used as a user token. The API Gateway enforces this at the proxy layer.

### Permission Clamping

When a superuser creates a subordinate admin account, the spawned account's permissions are clamped to a strict subset of the grantor's permissions. A Finance Admin cannot create another admin with analytics access they don't hold themselves. The clamping logic lives in `admin-service/utils/clampPermissions.js` and is enforced on both account creation and permission updates.

### Escrow Payment Flow

Payments are never transferred directly. When an order is placed:
1. Funds are held in escrow (`payment.status = held`)
2. Released only when the buyer confirms receipt or a dispute window expires
3. Disputed payments enter a resolution queue with configurable window (1–720 hours)
4. Partial refunds, full refunds, and split refunds are all supported
5. Payout holds can be placed on seller accounts by admin

### Platform Guard

Every service runs a shared `platformGuard` middleware that:
- Fetches initial platform state from Admin Service on startup
- Subscribes to `platform.lockdown` and `platform.maintenance_mode` EventBus events
- Polls every 5 seconds as a fallback for eventual consistency
- Blocks all non-admin traffic with 503 during lockdown
- Blocks write operations (non-GET) during maintenance mode
- Always allows `/health`, admin role, and auth paths through

This means a single toggle in the admin dashboard cascades across all 15 services within seconds.

### Admin Dashboard — 18 Tabs

A fully custom admin control surface built in EJS, served by the API Gateway. No external admin framework. Every tab is a standalone partial module with its own scoped JS and API calls.

| Tab | Capability |
|---|---|
| God View | Live platform pulse — orders, GMV, revenue, anomaly feed |
| Admin Accounts | Spawn/revoke admins, permission grid editor, MFA enforcement |
| System | Maintenance/lockdown toggles, feature flags, token nuke, platform fee |
| Users | Suspend, ban, restore, role change, delete with cascade |
| Sellers | Tier management, verification, suspension, profile inspection |
| Catalog | Pending review queue, approve/reject/feature/hard-delete |
| Orders | Force status, cancellation, order detail inspection |
| Payments | Escrow management, dispute resolution, payout holds, split refunds |
| Inventory | Stock adjustment, freeze, reservation summary |
| Messages | Thread moderation, system message injection, messaging bans |
| Shipping | All shipments, unshipped orders, stuck-in-transit detection |
| Reviews | Moderation queue, flagged content, bulk actions |
| Notifications | Log viewer, template editor, broadcast, delivery stats |
| Analytics | Chart.js visualisations — revenue trends, top products |
| Search | Index health, reindex, autocomplete management |
| Intelligence | Marketplace balance, onboarding funnel, fraud signals, seller scores |
| Config | Feature flag management, platform limits |
| Audit | Full admin action log with actor/action/timestamp filtering |

---

## Shared Infrastructure

```
shared/
├── eventBus.js           # In-process pub/sub — services communicate without HTTP coupling
├── middleware/
│   ├── verifyToken.js    # JWT verification used across all services
│   ├── parseUser.js      # Extracts user context from verified token
│   ├── enforceScope.js   # Scope-based route guard (catalog:read, orders:write, etc.)
│   └── platformGuard.js  # Lockdown/maintenance enforcement (injected into every service)
└── utils/
    └── errorResponse.js  # Consistent error shape across all services
```

The most important implementation detail here is that `eventBus.js` is process-local. The architecture depends on `start-monolith.js` loading every service in the same Node runtime so the EventBus remains shared.

---

## Deployment

The platform is designed for self-hosted deployment with zero cloud vendor lock-in:

- **PM2** manages all 15 service processes with auto-restart
- **GitHub Actions self-hosted runner** handles CI/CD — push to `main`, runner on the host machine pulls and reloads
- **Cloudflare Tunnel + custom domain routing** expose the platform publicly without opening ports or configuring a router
- **MongoDB** runs locally on the host machine

### Real Project Delivery Setup

In practice, this project has been served from:

- `markee.azah.trade`

That setup has been useful for testing because it lets the application run from my local machine while still being reachable through a stable public URL.

The deployment pattern is:

- the code lives in GitHub
- a self-hosted GitHub runner runs on my local computer
- pushes trigger pull/reload behavior on that machine
- PM2 keeps the Markee process alive
- Cloudflare Tunnel maps the local service to `markee.azah.trade`

This made it possible to test the system in a more realistic way than localhost-only development, while still keeping infrastructure lightweight and under my control.

```
git push origin main
       ↓
GitHub Actions (self-hosted runner on local host machine)
       ↓
git pull + pm2 reload all
       ↓
Live via Cloudflare Tunnel at markee.azah.trade
```

---

## Local Development

```bash
# Install dependencies across all services
find . -name "package.json" -not -path "*/node_modules/*" -maxdepth 2 -execdir npm install \;

# Copy and populate environment files
cp auth-service/.env.example auth-service/.env
# (repeat for each service)

# Start the full platform
node start-monolith.js

# Legacy debugging only: separate processes
./start-all.sh --legacy
```

Each service requires its own `.env` file. See `.env.example` in each service directory for required variables.

### Recommended Way To Run It

Use:

```bash
node start-monolith.js
```

or:

```bash
./start-all.sh
```

Do not present `--legacy` mode as the normal runtime. In legacy mode, services run as separate OS processes and the in-process EventBus no longer coordinates cross-service events correctly.

---

## Design Principles

This platform was built against a self-authored architectural protocol (m0t Base Protocol) that governs how services are built, how they communicate, and how operational state changes cascade. Key principles:

- **BUILDER.9** — every service must verify its own platform state, not rely on the gateway alone
- **OPERATOR.1.3** — be fully informed before acting (no blind mutations, always fetch current state first)
- **SYSTEM** — state changes cascade simultaneously across DB write, event emission, and audit log

### Practical Architectural Position

For class discussion, the clearest description is:

- Markee is not a classic single-codebase monolith where all domains are mixed together.
- Markee is not yet a fully broker-backed distributed microservice deployment either.
- Markee is a service-oriented backend system implemented in a monorepo and coordinated through a single-process runtime so that its event-driven workflows remain correct within project scope.

That distinction is important because it explains both the strengths of the system and its current limitation honestly.

---

## Author

**Toluwalase Mebaanne**  
Full-stack software developer  
This project represents independent systems design and implementation work — architecture, data modeling, authentication, payment flows, administrative tooling, and deployment infrastructure built end to end.
