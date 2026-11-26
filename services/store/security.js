const crypto = require("node:crypto");

module.exports = function createAccessControls({ getStaff, pool }) {
  const PERMISSION_CATALOG = [
    { id: "dashboard.view", label: "View dashboard" },
    { id: "orders.view", label: "View orders" },
    { id: "orders.update", label: "Update order status" },
    { id: "orders.cancel", label: "Cancel orders" },
    { id: "orders.payment.receive", label: "Record COD payment received" },
    { id: "products.view", label: "View products" },
    { id: "products.manage", label: "Create, edit, disable and delete products" },
    { id: "customers.view", label: "View customer profiles and order history" },
    { id: "analytics.view", label: "View analytics" },
    { id: "audit.view", label: "View activity log" }
  ];
  const GRANTABLE_PERMISSIONS = new Set(PERMISSION_CATALOG.map(item => item.id));
  const ROLE_PERMISSIONS = {
    owner: [...PERMISSION_CATALOG.map(item => item.id), "staff.manage"],
    manager: ["dashboard.view", "orders.view", "orders.update", "orders.cancel", "orders.payment.receive", "products.view", "products.manage", "analytics.view", "audit.view"],
    staff: ["dashboard.view", "orders.view", "orders.update", "orders.payment.receive", "products.view"]
  };
  const OWNER_ONLY_ROUTES = new Set(["offers.manage", "coupons.manage", "staff.manage"]);
  function effectivePermissions(user) {
    if (!user) return [];
    if (user.role === "owner") return ROLE_PERMISSIONS.owner;
    const saved = Array.isArray(user.permissions) ? user.permissions : ROLE_PERMISSIONS[user.role] || [];
    return [...new Set(saved.filter(permission => GRANTABLE_PERMISSIONS.has(permission)))];
  }
  function validatePermissions(value) {
    if (!Array.isArray(value)) return null;
    if (value.some(permission => typeof permission !== "string" || !GRANTABLE_PERMISSIONS.has(permission))) return null;
    return [...new Set(value)];
  }

  function safeEqual(a, b) {
    const aa = Buffer.from(String(a || ""));
    const bb = Buffer.from(String(b || ""));

    return aa.length === bb.length &&
      crypto.timingSafeEqual(aa, bb);
  }

  function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    return {
      salt,
      hash: crypto.scryptSync(password, salt, 64).toString("hex")
    };
  }

  function verifyPassword(password, salt, hash) {
    try {
      return safeEqual(
        crypto.scryptSync(password, salt, 64).toString("hex"),
        hash
      );
    } catch {
      return false;
    }
  }

  function publicStaff(user) {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      active: user.active,
      permissions: effectivePermissions(user),
      createdAt: user.createdAt
    };
  }
  function can(user, permission) {
    if (!user) return false;
    if (user.role === "owner") return true;
    if (OWNER_ONLY_ROUTES.has(permission)) return false;
    return effectivePermissions(user).includes(permission);
  }
  function requireOwner(req, res, next) {
    if (!(req.session?.admin || req.adminSession) || (req.session?.admin || req.adminSession).role !== "owner") {
      return res.status(403).json({ error: "Only the store owner can perform this action." });
    }
    next();
  }
  function requireAdmin(req, res, next) {
    if (!req.session || !req.session.admin) {
      return res.status(401).json({ error: "Please sign in again." });
    }
    const sessionUser = req.session.admin;
    if (sessionUser.role === "owner" && safeEqual(sessionUser.username, process.env.ADMIN_USERNAME)) {
      req.adminSession = sessionUser;
      return next();
    }
    if (!sessionUser.staffId) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: "Please sign in again." });
    }
    getStaff().then(users => {
      const user = users.find(item => item.id === sessionUser.staffId);
      if (!user || !user.active) {
        return req.session.destroy(() => res.status(401).json({ error: "This staff account is disabled. Please sign in again." }));
      }
      sessionUser.username = user.username;
      sessionUser.displayName = user.displayName;
      sessionUser.role = user.role;
      sessionUser.permissions = effectivePermissions(user);
      req.adminSession = sessionUser;
      next();
    }).catch(next);
  }
  function requirePermission(permission) {
    return (req, res, next) => {
      if (!can(req.adminSession, permission)) {
        return res.status(403).json({
          error: "Your role does not have permission for this action."
        });
      }

      next();
    };
  }

  async function audit(actor, action, details = {}) {
    try {
      await pool.query(
        `INSERT INTO audit_logs
         (actor, role, action, details, created_at)
         VALUES ($1, $2, $3, $4::jsonb, NOW())`,
        [
          actor?.username || "system",
          actor?.role || "system",
          action,
          JSON.stringify(details)
        ]
      );
    } catch (error) {
      console.error("Audit logging failed:", error.message);
    }
  }

  return { ROLE_PERMISSIONS, effectivePermissions, validatePermissions, safeEqual, hashPassword, verifyPassword, publicStaff, can, requireOwner, requireAdmin, requirePermission, audit };
};
