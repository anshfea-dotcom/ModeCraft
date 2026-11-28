# AERLON – Distributed rate-limit security audit

Base revision: 172244b069fd20dfacb424862c9890dd34e9d36e (main, 28 November 2026).
Implementation: security/tiered-distributed-rate-limits. **Not deployed to production**.

## Architecture and scope

This repository uses Node.js/Express and PostgreSQL, not Next.js Server Actions.
We found 116 externally described handlers across the gateway and standalone reader services
(including two dynamically registered image-administration handlers). Every /api/* request is
limited at the gateway before reaching the route handler; affiliate redirects, media reads and
/health are also covered. Standalone catalogue and media services have independent emergency
600/min limits when they are not gateway-managed loopback children. API 404 responses are also
covered; static assets and CORS OPTIONS preflight are not metered.

Each atomic rate counter is stored in shared PostgreSQL (api_rate_limits). Each failed-login
counter and temporary lock is stored in auth_lockouts. PostgreSQL transactions serialize
concurrent UPSERTs across all Render workers/instances. No Redis credentials are needed, and
counter-store outages respond with HTTP 503 (Retry-After: 30), not an open fallback.

## Configured tiers

| Category | Per-minute quota | Additional controls |
| --- | ---: | --- |
| Customer + admin login | 5/IP and 5/account | Five failed passwords in one 15-minute window cause 60s lockout; increasing backoff up to 30m; success clears failures |
| Admin challenge generation | 10/IP | Challenge token is still single-use |
| Signup, reset password, OTP (including future endpoints) | 5/IP; account where available | Grouped keys prevent path-ID rotation |
| Password-reset email request | 3/IP and 3/account | Limits mail sending and account probes |
| AI/LLM (/api/ai/*, /api/chat, /api/generate, etc.) | 15/IP and 15/session user | 200/day per user (anonymous uses IP), plus 500/day per IP; *request* quota, not actual token accounting |
| Checkout order and payment confirmation | 12/IP and 12/session user | COD, gift checkout and Razorpay order/verify |
| Coupons and gift-card lookup | 12/IP and 12/session user | Prevents cheap brute-force checking |
| Address lookup | 20/IP and 20/session user | Geolocation and postal requests |
| Order tracking | 20/IP and 20/session user | Reduces order enumeration |
| Newsletter subscription | 5/IP and 5/account | Reduces mass signup |
| Admin operational backup | 10/IP and 10/session user | Expensive export |
| Other API reads | 120/IP and 120/session user | Covers all GET/HEAD APIs |
| Other API writes | 60/IP and 60/session user | Covers POST, PUT, PATCH, DELETE |
| Razorpay signed webhook | 300/IP | Raw body/signature verification preserved; re-delivery capacity |
| Editorial media | 180/IP | Gateway endpoint |
| Affiliate redirect | 90/IP | Gateway endpoint |
| Health check | 60/IP | Gateway endpoint |
| Standalone catalogue/media readers | 600/socket IP | Only if externally hosted; bypassed for gateway-managed loopback subprocesses |

All rejected quota requests respond **429**, with Retry-After (seconds), RateLimit-Limit,
RateLimit-Remaining and RateLimit-Reset plus no-store. Limits are fixed 60-second windows;
daily AI limits use a rolling 86,400-second window from first hit.

## IP trust – mandatory deployment review

The old blanket trust-proxy=1 configuration has been removed. The gateway now trusts
ONLY reverse proxy networks explicitly listed in **TRUSTED_PROXY_CIDRS** (comma-separated).
The rate limiter uses Express's resolved req.ip, never manually parses untrusted X-Forwarded-For.
When no list is set, Express uses only the actual socket peer. This fails safely against IP
spoofing, but multiple customers behind one cloud ingress may share the same quota.
**Do not deploy until you have verified the actual trusted Render ingress CIDRs and run a
real-client-IP test from multiple independent networks.** Never use trust proxy=true,
0.0.0.0/0 or a guess at the number of hops. The production session middleware keeps Secure
cookies working through TLS-terminating ingress independently of IP-trust configuration.

Recommended environment variable: RATE_LIMIT_KEY_SECRET (stable high-entropy random key,
stored only in Render environment; SESSION_SECRET/ADMIN_PASSWORD fallback exists for
compatibility). The DB schema adds only the two new tables and their indexes.
No production database migration or environment change has yet been executed.

## Verification

- npm run check (includes scripts/qa-rate-limits.js for policy map, 429, spoofing, fail-closed)
- RATE_LIMIT_TEST_DATABASE_URL=<test db URL> node scripts/qa-rate-limits-db.js
  (tests concurrent atomic reservations and auth failure lockouts)
- Pull-request GitHub Action rate-limits-security.yml runs the PostgreSQL integration tests.
- Before merging, separately run multi-instance/per-IP stress tests, actual Render ingress tests,
  payment webhook retries, login/reset flows and mobile storefront regression smoke tests.
- Future real LLM handlers must meter actual provider-reported tokens if a true daily token
  budget is required. This code guarantees daily *request* caps today. No LLM endpoint exists
  in the inspected backend yet.

## Audited endpoint inventory

### server.js

- POST /api/razorpay/webhook
- GET /health
- GET /api/products
- GET /api/config

### services/media/routes.js

- GET /storefront-images/:slot
- PUT /api/admin/storefront/images/:slot
- DELETE /api/admin/storefront/images/:slot

### services/store/customers.js

- POST /api/auth/signup
- POST /api/auth/login
- POST /api/auth/activity
- GET /api/auth/me
- POST /api/auth/logout
- POST /api/auth/forgot-password
- POST /api/auth/reset-password
- GET /api/orders/my
- GET /api/orders/track
- GET /api/products/:id/reviews
- POST /api/products/:id/reviews
- POST /api/products/:id/stock-notifications
- GET /api/wishlist
- POST /api/wishlist/:productId
- DELETE /api/wishlist/:productId

### services/store/staff.js

- POST /api/admin/login-challenge
- POST /api/admin/login
- POST /api/admin/session/activity
- GET /api/admin/me
- POST /api/admin/logout
- GET /api/admin/staff
- POST /api/admin/staff
- PATCH /api/admin/staff/:id
- DELETE /api/admin/staff/:id
- GET /api/admin/audit

### services/store/storefront.js

- GET /api/storefront/header
- POST /api/storefront/newsletter
- GET /api/admin/newsletter/subscribers
- GET /api/admin/storefront/header
- PUT /api/admin/storefront/header
- GET /api/storefront/footer
- GET /api/admin/storefront/footer
- PUT /api/admin/storefront/footer
- GET /api/storefront/banners
- GET /api/admin/banners
- POST /api/admin/banners
- PATCH /api/admin/banners/:id
- DELETE /api/admin/banners/:id

### services/store/checkout.js

- GET /api/coupons/validate
- GET /api/admin/offers
- POST /api/admin/offers
- PATCH /api/admin/offers/:id
- DELETE /api/admin/offers/:id
- POST /api/coupons/validate
- POST /api/orders/cod
- POST /api/orders/gift
- POST /api/payments/razorpay/order
- POST /api/payments/razorpay/verify

### services/store/orders.js

- GET /api/admin/orders
- GET /api/admin/customers
- PATCH /api/admin/orders/:id/archive
- PATCH /api/admin/orders/:id
- PATCH /api/admin/orders/:id/payment
- GET /api/admin/analytics

### services/store/products.js

- GET /api/admin/products
- POST /api/admin/products
- PATCH /api/admin/products/:id
- DELETE /api/admin/products/:id
- POST /api/admin/products/reorder

### services/store/invoices.js

- GET /api/admin/invoices/profile
- PUT /api/admin/invoices/profile
- GET /api/admin/invoices
- POST /api/admin/invoices
- DELETE /api/admin/invoices/:id
- GET /api/admin/invoices/:id/pdf

### services/store/gst-invoices.js

- POST /api/admin/gst-invoices
- GET /api/admin/gst-invoices/:id/pdf

### services/store/admin-operations.js

- GET /api/admin/pos/variants
- POST /api/admin/pos/orders
- PATCH /api/admin/orders/:id/shipping

### services/store/warehouses.js

- GET /api/admin/warehouses
- GET /api/admin/warehouses/variants
- POST /api/admin/warehouses
- PATCH /api/admin/warehouses/:id
- PUT /api/admin/warehouses/stock

### services/store/admin-catalogue.js

- GET /api/admin/catalogue/taxonomy
- PATCH /api/admin/catalogue/categories
- PATCH /api/admin/catalogue/brands
- GET /api/admin/backups/operational.json

### services/store/inventory.js

- GET /api/admin/inventory/alerts
- GET /api/admin/inventory
- POST /api/admin/inventory
- POST /api/admin/inventory/bulk
- PATCH /api/admin/inventory/:id
- DELETE /api/admin/inventory/:id

### services/store/advanced-affiliates.js

- GET /r/:code
- GET /api/admin/affiliates
- POST /api/admin/affiliates
- PATCH /api/admin/affiliates/:id

### services/store/advanced-automations.js

- GET /api/admin/automations
- POST /api/admin/automations
- PATCH /api/admin/automations/:id
- POST /api/admin/automations/run
- PATCH /api/admin/automations/alerts/:id

### services/store/advanced-gifts.js

- GET /api/admin/gift-cards
- POST /api/admin/gift-cards
- PATCH /api/admin/gift-cards/:id
- POST /api/admin/gift-cards/:id/redeem
- POST /api/gift-cards/check

### services/store/advanced-seo.js

- GET /api/admin/seo
- PUT /api/admin/seo

### services/store/address.js

- POST /api/checkout/address/:kind

### services/store/admin-notifications.js

- GET /api/admin/notifications/deleted
- POST /api/admin/notifications/delete

### services/store/customer-addresses.js

- GET /api/customer/addresses
- POST /api/customer/addresses
- DELETE /api/customer/addresses/:id

### services/catalogue/server.js (standalone)

- GET /api/products

### services/media/server.js (standalone)

- GET /storefront-images/:slot
