const VALID_ORDER_STATUSES = new Set([
  "received",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
  "awaiting_payment"
]);

module.exports = function registerOrderManagement(app, { requireAdmin, requirePermission, getOrders, pool, ensureCustomerRecord, requireOwner, getOrder, putOrder, audit, cleanText, can }) {
  app.get(
    "/api/admin/orders",
    requireAdmin,
    requirePermission("orders.view"),
    async (req, res, next) => {
      try {
        const orders = await getOrders();
        const includeArchived = req.query?.includeArchived === "true";
        const visibleOrders = (includeArchived ? orders : orders.filter(order => !order.archivedAt))
          .map(order => req.adminSession?.role === "owner" ? order : ({
              ...order,
              customer: order.customer ? { name: order.customer.name || "Customer", email: "", phone: "", address: "", city: "", postalCode: "" } : order.customer
            }));
        res.json({ orders: visibleOrders });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/admin/customers",
    requireAdmin,
    requirePermission("customers.view"),
    async (_req, res, next) => {
      try {
        const result = await pool.query(
          "SELECT id, name, email, phone, created_at FROM customers ORDER BY created_at DESC LIMIT 1000"
        );
        const orders = await getOrders();
        // Backfill older guest checkouts into the persistent directory when the owner opens it.
        for (const order of orders) {
          if (!order.archivedAt && order.customer?.email && order.customer?.phone) await ensureCustomerRecord(order.customer);
        }
        const refreshed = await pool.query("SELECT id, name, email, phone, created_at FROM customers ORDER BY created_at DESC LIMIT 1000");
        const customers = refreshed.rows.map(row => {
          const history = orders.filter(order =>
            String(order.customer?.email || "").toLowerCase() === String(row.email || "").toLowerCase() ||
            String(order.customer?.phone || "") === String(row.phone || "")
          ).map(order => ({
            id: order.id,
            createdAt: order.createdAt,
            total: Number(order.total || 0),
            paymentMethod: order.paymentMethod || "—",
            paymentStatus: order.paymentStatus || "pending",
            orderStatus: order.orderStatus || "received",
            address: order.customer?.address || "",
            city: order.customer?.city || "",
            postalCode: order.customer?.postalCode || "",
            items: Array.isArray(order.items) ? order.items : []
          }));
          return {
            id: row.id,
            name: row.name,
            email: row.email,
            phone: row.phone,
            createdAt: row.created_at,
            orderCount: history.length,
            totalSpent: history.filter(o => o.paymentStatus === "paid").reduce((sum, o) => sum + Number(o.total || 0), 0),
            orders: history
          };
        });
        res.json({ customers });
      } catch (error) {
        next(error);
      }
    }
  );


  app.patch("/api/admin/orders/:id/archive", requireAdmin, requireOwner, async (req, res, next) => {
    try {
      const order = await getOrder(req.params.id);
      if (!order) return res.status(404).json({ error: "Order not found." });
      const restore = req.body?.restore === true;
      if (restore) { delete order.archivedAt; delete order.archivedBy; }
      else { order.archivedAt = new Date().toISOString(); order.archivedBy = req.adminSession.username; }
      order.updatedAt = new Date().toISOString();
      await putOrder(order);
      await audit(req.adminSession, restore ? "order.restored" : "order.archived", { orderId: order.id });
      res.json({ ok: true, order });
    } catch (error) { next(error); }
  });

  app.patch(
    "/api/admin/orders/:id",
    requireAdmin,
    requirePermission("orders.update"),
    async (req, res, next) => {
      let client;
      try {
        const status = cleanText(req.body?.orderStatus, 40);
        const reason = cleanText(req.body?.cancellationReason, 300);

        if (!VALID_ORDER_STATUSES.has(status)) {
          return res.status(400).json({ error: "Invalid order status." });
        }

        if (
          status === "cancelled" &&
          !can(req.adminSession, "orders.cancel")
        ) {
          return res.status(403).json({
            error: "Only owners and managers can cancel orders."
          });
        }

        if (status === "cancelled" && !reason) {
          return res.status(400).json({
            error: "Enter a cancellation reason."
          });
        }

        client = await pool.connect();
        await client.query('BEGIN');
        const locked = await client.query('SELECT data FROM orders WHERE id=$1 FOR UPDATE', [req.params.id]);
        const order = locked.rows[0]?.data || null;

        if (!order) {
          return res.status(404).json({ error: "Order not found." });
        }

        if (
          ["delivered", "cancelled"].includes(order.orderStatus) &&
          status !== order.orderStatus
        ) {
          return res.status(409).json({
            error: "Delivered or cancelled orders cannot be reopened."
          });
        }

        if (!Array.isArray(order.statusHistory)) {
          order.statusHistory = [];
        }

        order.statusHistory.push({
          status,
          reason: status === "cancelled" ? reason : "",
          by: req.adminSession.username,
          at: new Date().toISOString()
        });

        order.orderStatus = status;
        if (status === "cancelled") order.cancellationReason = reason;
        order.updatedAt = new Date().toISOString();


        // Only orders created with reservations can be restored. Legacy orders were not debited.
        if (status === "cancelled" && Array.isArray(order.stockReservations) && !order.stockReleased) {
          for (const line of order.stockReservations) {
            const quantity = Number(line.quantity);
            if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("Invalid recorded stock reservation.");
            const result = line.kind === "variant"
              ? await client.query(
                  "UPDATE inventory_variants SET quantity=quantity+$2,updated_at=NOW() WHERE id=$1 RETURNING id",
                  [line.id, quantity]
                )
              : line.kind === "product"
                ? await client.query(
                    "UPDATE products SET data=jsonb_set(data,'{stock}',to_jsonb(COALESCE((data->>'stock')::int,0)+$2)),updated_at=NOW() WHERE id=$1 RETURNING id",
                    [line.id, quantity]
                  )
                : { rowCount: 0 };
            if (!result.rowCount) {
              const error = new Error("Unable to restore reserved stock. Check the product's inventory."); error.status = 409; throw error;
            }
          }
          order.stockReleased = true;
        }
        await client.query("UPDATE orders SET data=$2::jsonb,updated_at=NOW() WHERE id=$1", [order.id, JSON.stringify(order)]);
        await client.query("COMMIT");
        client.release(); client = null;

        await audit(req.adminSession, "order.status.updated", {
          orderId: order.id,
          status
        });

        const responseOrder = req.adminSession.role === "owner" ? order : {
          ...order,
          customer: order.customer ? { name: order.customer.name || "Customer", email: "", phone: "", address: "", city: "", postalCode: "" } : order.customer
        };
        res.json({ ok: true, order: responseOrder });
      } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        next(error);
      } finally { client?.release(); }
    }
  );

  app.patch(
    "/api/admin/orders/:id/payment",
    requireAdmin,
    requirePermission("orders.payment.receive"),
    async (req, res, next) => {
      try {
        const order = await getOrder(req.params.id);
        if (!order) return res.status(404).json({ error: "Order not found." });
        if (String(order.paymentMethod || "").toUpperCase() !== "COD") {
          return res.status(409).json({ error: "Only COD payments can be manually marked as received. Online payments must be verified by Razorpay." });
        }
        if (order.paymentStatus === "paid") {
          return res.status(409).json({ error: "This order is already marked as paid." });
        }
        const note = cleanText(req.body?.note, 250);
        order.paymentStatus = "paid";
        order.paymentReceivedAt = new Date().toISOString();
        order.paymentReceivedBy = req.adminSession.username;
        order.paymentReceivedRole = req.adminSession.role;
        order.paymentReceivedNote = note;
        order.updatedAt = new Date().toISOString();
        if (!Array.isArray(order.paymentHistory)) order.paymentHistory = [];
        order.paymentHistory.push({
          status: "paid",
          method: "COD",
          by: req.adminSession.username,
          role: req.adminSession.role,
          note,
          at: order.paymentReceivedAt
        });
        await putOrder(order);
        await audit(req.adminSession, "order.payment.received", { orderId: order.id, method: "COD" });
        res.json({ ok: true, orderId: order.id, paymentStatus: order.paymentStatus, paymentReceivedAt: order.paymentReceivedAt, paymentReceivedBy: order.paymentReceivedBy });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/admin/analytics",
    requireAdmin,
    requirePermission("analytics.view"),
    async (_req, res, next) => {
      try {
        const orders = await getOrders();
        const paid = orders.filter(order => order.paymentStatus === "paid");
        const active = orders.filter(
          order => !["cancelled", "delivered"].includes(order.orderStatus)
        );

        const byDay = [];

        for (let i = 6; i >= 0; i--) {
          const date = new Date();
          date.setHours(0, 0, 0, 0);
          date.setDate(date.getDate() - i);

          const key = date.toISOString().slice(0, 10);
          const dayOrders = orders.filter(
            order => String(order.createdAt || "").slice(0, 10) === key
          );

          byDay.push({
            date: key,
            orders: dayOrders.length,
            revenue: dayOrders
              .filter(order => order.paymentStatus === "paid")
              .reduce((sum, order) => sum + Number(order.total || 0), 0)
          });
        }

        const lowStockResult = await pool.query("SELECT COUNT(*)::int AS count FROM inventory_variants WHERE quantity <= 5");
        res.json({
          lowStockVariants: lowStockResult.rows[0]?.count || 0,
          totalOrders: orders.length,
          pendingOrders: active.length,
          paidOrders: paid.length,
          cancelledOrders: orders.filter(
            order => order.orderStatus === "cancelled"
          ).length,
          paidRevenue: paid.reduce(
            (sum, order) => sum + Number(order.total || 0),
            0
          ),
          byDay
        });
      } catch (error) {
        next(error);
      }
    }
  );
};
