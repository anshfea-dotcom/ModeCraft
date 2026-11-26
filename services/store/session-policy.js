const minute = 60_000;
const absoluteLifetime = 8 * 60 * minute;
const customerIdle = 30 * minute;
const adminLifetime = 5 * minute;

// Keep activity outside the session JSON so concurrent requests cannot roll
// the deadline back or revive an expired session with an old cookie.
async function remainingSession(pool, req, role, active) {
  const issued = req.session?.[role]?.issuedAt;
  if (!Number.isSafeInteger(issued)) return 0;
  // express-session loaded this identity from the server-side session store.
  // Only sign-in issues a new timestamp. Reads, writes and refreshes share it.
  if (role === "admin") {
    const age = Date.now() - issued;
    return age >= 0 ? Math.max(0, adminLifetime - age) : 0;
  }
  const deadline = "LEAST($2::timestamptz + $4 * interval '1 millisecond', COALESCE(last_activity, $2) + $3 * interval '1 millisecond')";
  const remaining = 'EXTRACT(EPOCH FROM (' + deadline + ' - NOW())) * 1000 AS remaining';
  const live = 'sid = $1 AND expire > NOW() AND ' + deadline + ' > NOW()';
  const sql = active
    ? 'UPDATE user_sessions SET last_activity = GREATEST(COALESCE(last_activity, $2), NOW()) WHERE ' + live + ' RETURNING ' + remaining
    : 'SELECT ' + remaining + ' FROM user_sessions WHERE ' + live;
  const result = await pool.query(sql, [req.sessionID, new Date(issued), customerIdle, absoluteLifetime]);
  return Math.max(0, Math.floor(Number(result.rows[0]?.remaining || 0)));
}

module.exports = { remainingSession };
