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
