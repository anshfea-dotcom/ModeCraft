# AERLON Store

A starter custom storefront for AERLON using HTML/CSS/JavaScript, Node.js/Express, server-side order validation, Cash on Delivery, and Razorpay checkout scaffolding.

## Code layout

| Location | Responsibility |
| --- | --- |
| `server.js` | Public HTTP entry point, middleware, session setup and service lifecycle |
| `services/catalogue/` | Product catalogue reads |
| `services/media/` | Editorial image reads and owner-authorized upload and restore routes |
| `services/store/` | Customer accounts, staff, orders, checkout, inventory, products and storefront settings |
| `public/assets/images/` | Editorial WebP files |
| `public/assets/css/` and `public/assets/js/` | Browser styles and scripts |
| `views/account.html` | Shared login, signup and password-reset markup |

## Run locally

Use Node.js 20 or newer and PostgreSQL. Supply `DATABASE_URL`, `ADMIN_USERNAME` and `ADMIN_PASSWORD` through the environment or a local `.env` file. Run `npm install`, then `npm start`. The default storefront address is `http://localhost:3000`. Run `npm run check` for the build checks.

The gateway starts catalogue and media readers as separate loopback processes after database initialization. It restarts failed readers and can serve reads from PostgreSQL during recovery. Owner writes, customer sessions and payments stay in the gateway. Existing image keys and public URLs work with this layout.

For separate hosts, launch `node services/catalogue/server.js` and `node services/media/server.js` with `DATABASE_URL` and `PORT` configured. Set `CATALOGUE_SERVICE_URL` and `MEDIA_SERVICE_URL` on the gateway to their internal HTTP origins. The default Render deployment runs all three processes on the existing instance.

## Enable Razorpay test payments
1. Create or sign in to your Razorpay account and complete the business/account setup they require.
2. In the Razorpay Dashboard, use test mode and create API keys.
3. Put the Key ID and Key Secret in `.env` as `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
4. Restart the server after editing `.env`.
5. For payment webhooks, configure a webhook endpoint at `https://YOUR-DOMAIN/api/razorpay/webhook` and use the same secret in `RAZORPAY_WEBHOOK_SECRET`.
6. Test successful, failed, cancelled and duplicate-payment cases before going live.

The Key Secret must remain on the server and must never be placed in `public/index.html` or committed to source control. The browser uses only the Key ID.

## Important before launch
This is a starter, not a complete production commerce platform:
- Orders, sessions and admin-managed settings are stored in PostgreSQL.
- Razorpay signature verification is implemented, but the webhook handler currently validates and logs events only. Build idempotent webhook processing and reconciliation before accepting live orders.
- Add rate limiting, CSRF strategy where relevant, secure headers, request logging, backups, privacy notice, terms, return/refund policy, shipping policy, GST/invoicing assessment, and support contact.
- No supplier/dropshipping provider is connected. You must source products from a supplier, confirm stock, shipping charges, delivery estimates, return address and reverse-logistics policy. The demo catalog is sample data.
- No order confirmation email/SMS is sent yet.
- Do not promise supplier stock or delivery dates until confirmed. COD orders need confirmation and fraud controls.
- Use HTTPS in production. Set `ALLOWED_ORIGIN` to your actual domain.
- For a production deployment, move orders to PostgreSQL/MySQL or a managed database, and store payment state based on verified server-side events.
- Check Razorpay's current eligibility, KYC, settlement, fee and policy requirements directly with Razorpay before going live.

## Secret configuration and safe deployment

Copy `.env.example` to a local `.env` file and set values on the **server only**. Never commit a real `.env` file. Configure the same server-side values in your deployment platform's secret/environment settings, not in public JavaScript, HTML, or client-prefixed variables (`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`).

`SESSION_SECRET` is mandatory and must be at least 32 UTF-8 bytes. Generate a unique cryptographically random value with `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`; store its output only in your secret manager or local `.env`. Never reuse `ADMIN_PASSWORD` as the session secret. `AFFILIATE_SIGNING_SECRET` is optional; if omitted, affiliate cookies use the server-side `SESSION_SECRET`, with domain-separated HMAC inputs. Rotating these values invalidates existing signed sessions/referral cookies.

`RAZORPAY_KEY_ID` is a publishable checkout identifier; `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` must remain private. `DATABASE_URL`, admin credentials, Resend/SMTP passwords and session/signing secrets must remain private. The example file contains no live values.

**Production rollout:** configure `SESSION_SECRET` before deploying a build that requires it. Test a fresh admin login and session expiration, payment webhook signature validation, and affiliate referrals in staging first. Rotate any credential found in Git history **before** history rewriting; rewriting history does not invalidate a leaked credential.

For a complete local secret scan, run `gitleaks git --log-opts="--all" --redact` (Gitleaks 8.24+) on a fully fetched clone, and run `gitleaks dir --redact .` for the working tree. Inspect every candidate without sharing secret values. Run it again after cleanup and before production deployment.
