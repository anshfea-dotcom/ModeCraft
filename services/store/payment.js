const reject = (status, message) => Object.assign(new Error(message), { status });

// Both a signed gateway event and the client callback resolve through the same row lock.
async function confirmCapturedPayment(pool, payment) {
  if (!payment?.id || !payment.order_id || payment.status !== "captured")
    throw reject(409, "Payment is awaiting confirmation. Check with customer care before paying again.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT id,data FROM orders WHERE data->>'razorpayOrderId'=$1 FOR UPDATE", [payment.order_id]);
    const row = result.rows[0];
    if (!row) throw reject(404, "Order not found.");
    const order = row.data;
    if (order.currency !== payment.currency || Math.round(order.total * 100) !== Number(payment.amount))
      throw reject(409, "Payment details do not match the order.");
    if (order.paymentStatus === "paid") {
      if (order.paymentId !== payment.id) throw reject(409, "A different payment has already been recorded.");
    } else {
      if (order.paymentStatus !== "created" || order.orderStatus !== "awaiting_payment")
        throw reject(409, "This order is not awaiting payment.");
      Object.assign(order, { paymentId: payment.id, paymentStatus: "paid", orderStatus: "received", paidAt: new Date().toISOString() });
      await client.query("UPDATE orders SET data=$1::jsonb,updated_at=NOW() WHERE id=$2", [JSON.stringify(order), row.id]);
      if (order.couponCode) await client.query("UPDATE offers SET data=jsonb_set(data,'{usageCount}',to_jsonb(COALESCE((data->>'usageCount')::int,0)+1)),updated_at=NOW() WHERE code=$1", [order.couponCode]);
    }
    await client.query("COMMIT");
    return { ok: true, orderId: order.id, message: "Payment confirmed. Track your order using its reference." };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
module.exports = { confirmCapturedPayment };
