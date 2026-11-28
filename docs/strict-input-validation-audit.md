# AERLON — Strict request input validation audit

Base code revision: 172244b069fd20dfacb424862c9890dd34e9d36e.
Updated on: 28 November 2026.
Branch: `security/tiered-distributed-rate-limits` (PR #21, not production).
Total audited externally reachable registrations: **116** (including 2 standalone reader registrations and the 2 dynamic WebP admin write routes).

## What the inspection found

The earlier code had scattered, handler-local checks, but **no comprehensive Zod
request boundary**. Some handlers truncated strings (instead of rejecting input
over maxima), cast untrusted flags with Boolean(), silently dropped unknown
nested properties, or merged caller-provided objects into saved records. The
new schema layer is designed to reject these cases before any *business*
handler or session-database query is executed.

- Auth/identity: login, signup, forgot/reset, admin challenges, staff management
- Customer: saved addresses, wishlists, product reviews, stock alerts, order tracking
- Checkout: nested cart/line items, customer address, coupons, gift balance,
  payment verification and signed Razorpay webhook
- Admin: product stock grids, color/sizes mapping, inventory, warehouses,
  POS orders, order status/payment/shipping, affiliate rates, automation rules
- Documents: manual invoices, deletion confirmation, GST invoice lines and
  business profile
- Presentation: header, footer/social links, banner metadata, SEO, newsletter
- Read-only APIs still receive strict empty body and query schemas where no
  external fields are expected. Relevant cookies are validated before session
  middleware. Unsupported API paths fail closed with HTTP 404.

## Enforcement

`services/store/input-schemas.js`: explicit strict schemas per route, field
bounds, enums and numeric parsing for HTML number inputs. Nested objects
are strict, including cart items, product color maps/stock grids, invoice lines,
footer columns/links and profiles.

`services/store/validate-input.js`: validates body/query/path and recognized
session/affiliate cookies; malformed or unknown body fields return **HTTP 400**
with a bounded list of safe field errors. API requests are validated before
normal session handlers and database reads. Exemptions are documented: signed
Razorpay webhooks preserve raw bytes for HMAC verification, then validate a
projected, whitelisted event; raw WebP uploads validate bytes after the raw
parser but before authentication session queries.

Text sanitization policy: the storefront is plain text, not rich HTML.
Markup (< and >), script tags and control characters are **rejected** for
descriptions, review text, SEO, customer and admin content. Existing HTML
output escaping must remain in place; URL fields accept only safe schemes.

There is no Next.js Server Actions framework in this Node/Express repository.
Standalone catalogue/media endpoints read only path variables and have
gateway or independent limiter protection. Routes that never accept JSON
bodies are checked with strict empty schemas.

## Complete pre-patch inventory and post-patch coverage

Each route below was reviewed for missing *centralized* schema validation.
Some had partial local validation before; all are now represented in the
central registry or, for raw webhook/image bytes, have a dedicated validator.
A later route addition without a schema is denied at the API gateway; the
CI schema-coverage test also fails if a registered route is omitted.

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

## Test and release gates

- `node scripts/qa-input-validation.js`: route completeness, input validation, XSS and mass-assignment rejection, cookies, signed webhook projection.
- `npm run check`: full regression suite including the security test.
- GitHub browser CI: checkout and admin responsive flows.
- Run real-world proxy, payment webhook redelivery, checkout, GST issuance, multi-instance load and malformed-body tests before merge/deploy.

**Important:** A request returning HTTP 400 is not proof against every class of XSS; maintain context-aware output encoding and Content Security Policy. Ensure these checks remain in CI.
