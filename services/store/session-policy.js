const minute = 60_000;
const absoluteLifetime = 8 * 60 * minute;
const customerIdle = 30 * minute;
const adminIdle = 30 * minute;

// Keep activity outside the session JSON so concurrent requests cannot roll
// the deadline back or revive an expired session with an old cookie.
async function remainingSession(pool, req, role, active) {
  const issued = req.session?.[role]?.issuedAt;
  if (!Number.isSafeInteger(issued)) return 0;
  // Both admin and customer sessions use server-side sliding idle deadlines.
  // An issued session cannot be extended past the eight-hour hard limit.
  if (issued > Date.now()) return 0;
  const idle = role === "admin" ? adminIdle : customerIdle;
  const deadline = "LEAST($2::timestamptz + $4 * interval '1 millisecond', COALESCE(last_activity, $2) + $3 * interval '1 millisecond')";
  const remaining = 'EXTRACT(EPOCH FROM (' + deadline + ' - NOW())) * 1000 AS remaining';
  const live = 'sid = $1 AND expire > NOW() AND ' + deadline + ' > NOW()';
  const sql = active
    ? 'UPDATE user_sessions SET last_activity = GREATEST(COALESCE(last_activity, $2), NOW()) WHERE ' + live + ' RETURNING ' + remaining
    : 'SELECT ' + remaining + ' FROM user_sessions WHERE ' + live;
  const result = await pool.query(sql, [req.sessionID, new Date(issued), idle, absoluteLifetime]);
  return Math.max(0, Math.floor(Number(result.rows[0]?.remaining || 0)));
}

module.exports = { remainingSession };
