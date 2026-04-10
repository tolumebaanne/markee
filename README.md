# Markee — Marketplace Platform

**Author:** Toluwalase Mebaanne  
**Type:** Full-stack distributed system — architectural portfolio piece  
**Stack:** Node.js · Express · MongoDB · EJS · JWT · EventBus · PM2 · Cloudflare Tunnel

---

## What This Is

Markee is a production-grade marketplace platform built from the ground up as a microservice monorepo. It covers the full lifecycle of a two-sided marketplace — buyers discovering and purchasing products, sellers managing inventory and storefronts, and operators running the platform through a comprehensive admin control system.

This is not a tutorial project. Every architectural decision was made with real operational concerns in mind: how does lockdown propagate across 15 services simultaneously? How do you ensure a spawned admin account can never exceed the permissions of the account that created it? How do you build an escrow system where funds are only released when both parties confirm?

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

**15 services. One monorepo. One EventBus. Zero shared databases.**

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

---

## Deployment

The platform is designed for self-hosted deployment with zero cloud vendor lock-in:

- **PM2** manages all 15 service processes with auto-restart
- **GitHub Actions self-hosted runner** handles CI/CD — push to `main`, runner on host machine pulls and reloads
- **Cloudflare Tunnel** exposes the platform publicly without opening ports or configuring a router
- **MongoDB** runs locally on the host machine

```
git push origin main
       ↓
GitHub Actions (self-hosted runner on host machine)
       ↓
git pull + pm2 reload all
       ↓
Live in ~15 seconds via Cloudflare Tunnel
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

# Or start individual services
node api-gateway/server.js
node auth-service/server.js
# etc.
```

Each service requires its own `.env` file. See `.env.example` in each service directory for required variables.

---

## Design Principles

This platform was built against a self-authored architectural protocol (m0t Base Protocol) that governs how services are built, how they communicate, and how operational state changes cascade. Key principles:

- **BUILDER.9** — every service must verify its own platform state, not rely on the gateway alone
- **OPERATOR.1.3** — be fully informed before acting (no blind mutations, always fetch current state first)
- **SYSTEM** — state changes cascade simultaneously across DB write, event emission, and audit log

---

## Author

**Toluwalase Mebaanne**  
Full-stack software developer  
This project represents independent systems design and implementation work — architecture, data modeling, authentication, payment flows, administrative tooling, and deployment infrastructure built end to end.
