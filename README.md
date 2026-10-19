# ModeCraft Store

A starter custom storefront for ModeCraft using HTML/CSS/JavaScript, Node.js/Express, server-side order validation, Cash on Delivery, and Razorpay checkout scaffolding.

## Requirements
- Node.js 20 or newer
- A terminal / command prompt
- Razorpay account for live online payments (test keys first)

## Run locally
1. Extract this project folder.
2. Open a terminal in the `modecraft-store` folder.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Copy `.env.example` to `.env`.
   - Windows PowerShell: `Copy-Item .env.example .env`
   - macOS/Linux: `cp .env.example .env`
5. Start the site:
   ```bash
   npm start
   ```
6. Open `http://localhost:3000`.

The storefront loads its products from `/api/products`. Keep the HTML served by this Express app so API requests are same-origin.

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
- Orders are stored in `data/orders.json`, which is suitable only for local testing/small demos. Use a real database for production.
- Add admin authentication and a protected order dashboard; never expose order files publicly.
- Razorpay signature verification is implemented, but the webhook handler currently validates and logs events only. Build idempotent webhook processing and reconciliation before accepting live orders.
- Add rate limiting, CSRF strategy where relevant, secure headers, request logging, backups, privacy notice, terms, return/refund policy, shipping policy, GST/invoicing assessment, and support contact.
- No supplier/dropshipping provider is connected. You must source products from a supplier, confirm stock, shipping charges, delivery estimates, return address and reverse-logistics policy. The demo catalog is sample data.
- No order confirmation email/SMS is sent yet.
- Do not promise supplier stock or delivery dates until confirmed. COD orders need confirmation and fraud controls.
- Use HTTPS in production. Set `ALLOWED_ORIGIN` to your actual domain.
- For a production deployment, move orders to PostgreSQL/MySQL or a managed database, and store payment state based on verified server-side events.
- Check Razorpay's current eligibility, KYC, settlement, fee and policy requirements directly with Razorpay before going live.
