const crypto = require("node:crypto");
const { checkAuthLock, recordAuthFailure, clearAuthFailures } = require("./rate-limits");

module.exports = function registerStaff(app, { pool, cleanText, safeEqual, getStaff, verifyPassword, effectivePermissions, audit, requireAdmin, SESSION_COOKIE, requireOwner, publicStaff, ROLE_PERMISSIONS, validatePermissions, hashPassword, putStaff, removeStaff, requirePermission }) {
  function challengeHash(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  app.post("/api/admin/login-challenge", async (req, res, next) => {
    try {
      if (req.get("X-Admin-Login") !== "1") {
        return res.status(403).json({ error: "Please sign in from the admin page." });
      }
      if (!req.session.adminLoginStarted && !req.session.admin && !req.session.customer) {
        req.session.adminLoginStarted = true;
        await new Promise((resolve, reject) => {
          req.session.save(error => error ? reject(error) : resolve());
        });
      }
      const token = crypto.randomBytes(32).toString("hex");
      const issued = await pool.query(
        `UPDATE user_sessions SET admin_challenge_hash = $2,
           admin_challenge_expires = NOW() + INTERVAL '5 minutes'
         WHERE sid = $1 AND expire > NOW()`,
        [req.sessionID, challengeHash(token)]
      );
      if (!issued.rowCount) return res.status(403).json({ error: "Session expired. Try signing in again." });
      res.set("Cache-Control", "no-store").json({ token });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admin/login", async (req, res, next) => {
    try {
      const token = req.get("X-Admin-Login-Token");
      if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
        return res.status(403).json({ error: "Sign-in request expired. Please try again." });
      }
      const consumed = await pool.query(
        `UPDATE user_sessions SET admin_challenge_hash = NULL, admin_challenge_expires = NULL
         WHERE sid = $1 AND admin_challenge_hash = $2
           AND admin_challenge_expires > NOW() AND expire > NOW()`,
        [req.sessionID, challengeHash(token)]
      );
      if (!consumed.rowCount) {
        return res.status(403).json({ error: "Sign-in request expired. Please try again." });
      }

      const username = cleanText(req.body?.username, 100);
      const password = typeof req.body?.password === "string"
        ? req.body.password
        : "";

      if (!username || !password) {
        return res.status(400).json({
          error: "Enter username and password."
        });
      }

      const lockedFor = await checkAuthLock(pool, "admin", username);
      if (lockedFor) return res.set("Retry-After", String(lockedFor)).status(429)
        .json({ error: "Too many sign-in failures. Please retry later.", retryAfter: lockedFor });

      let account = null;

      if (
        safeEqual(username, process.env.ADMIN_USERNAME) &&
        safeEqual(password, process.env.ADMIN_PASSWORD)
      ) {
        account = {
          username: process.env.ADMIN_USERNAME,
          displayName: "Founder & CEO",
          role: "owner",
          active: true
        };
      } else {
        const users = await getStaff();
        const user = users.find(
          item => item.username.toLowerCase() === username.toLowerCase()
        );

        if (
          user &&
          user.active &&
          verifyPassword(password, user.salt, user.passwordHash)
        ) {
          account = {
            username: user.username,
            displayName: user.displayName,
            role: user.role,
            staffId: user.id,
            permissions: effectivePermissions(user),
            active: true
          };
        }
      }

      if (!account) {
        await recordAuthFailure(pool, "admin", username);
        return res.status(401).json({
          error: "Incorrect username or password, or account disabled."
        });
      }
      await clearAuthFailures(pool, "admin", username);

      req.session.regenerate(error => {
        if (error) return next(error);

        req.session.admin = { ...account, issuedAt: Date.now() };

        req.session.save(async saveError => {
          if (saveError) return next(saveError);

          await audit(account, "login");

          res.json({
            ok: true,
            user: {
              username: account.username,
              displayName: account.displayName,
              role: account.role
            }
          });
        });
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admin/session/activity", requireAdmin, (_req, res) => res.sendStatus(204));

  app.get("/api/admin/me", requireAdmin, (req, res) => {
    const user = req.adminSession;
    res.json({
      authenticated: true,
      role: user.role,
      username: user.username,
      displayName: user.displayName,
      isOwner: user.role === "owner",
      permissions: effectivePermissions(user)
    });
  });

  app.post("/api/admin/logout", async (req, res, next) => {
    const user = req.session?.admin;

    if (user) await audit(user, "logout");

    req.session.destroy(error => {
      res.clearCookie(SESSION_COOKIE, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production"
      });

      if (error) return next(error);

      res.json({ ok: true });
    });
  });

  app.get(
    "/api/admin/staff",
    requireAdmin,
    requireOwner,
    async (_req, res, next) => {
      try {
        res.json({ staff: (await getStaff()).map(publicStaff) });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/admin/staff",
    requireAdmin,
    requireOwner,
    async (req, res, next) => {
      try {
        const username = cleanText(req.body?.username, 60);
        const displayName = cleanText(req.body?.displayName, 100);
        const password = typeof req.body?.password === "string"
          ? req.body.password
          : "";
        const role = req.body?.role;
        const permissions = req.body?.permissions === undefined
          ? [...(ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.staff)]
          : validatePermissions(req.body.permissions);

        if (req.body?.permissions !== undefined && permissions === null) {
          return res.status(400).json({ error: "One or more permissions are invalid." });
        }
        if (!/^[a-zA-Z0-9._-]{3,60}$/.test(username)) {
          return res.status(400).json({
            error: "Username must be 3–60 characters using letters, numbers, dots, underscores or hyphens."
          });
        }

        if (
          displayName.length < 2 ||
          password.length < 10 ||
          !["manager", "staff"].includes(role)
        ) {
          return res.status(400).json({
            error: "Provide a display name, password of at least 10 characters, and Manager or Staff role."
          });
        }

        const users = await getStaff();

        if (users.some(
          user => user.username.toLowerCase() === username.toLowerCase()
        )) {
          return res.status(409).json({
            error: "That username already exists."
          });
        }

        const hashed = hashPassword(password);

        const user = {
          id: crypto.randomUUID(),
          username,
          displayName,
          role,
          permissions,
          active: true,
          salt: hashed.salt,
          passwordHash: hashed.hash,
          createdAt: new Date().toISOString()
        };

        await putStaff(user);
        await audit(req.adminSession, "staff.created", {
          staffId: user.id,
          role
        });

        res.status(201).json({
          ok: true,
          staff: publicStaff(user)
        });
      } catch (error) {
        next(error);
      }
    }
  );

  app.patch(
    "/api/admin/staff/:id",
    requireAdmin,
    requireOwner,
    async (req, res, next) => {
      try {
        const users = await getStaff();
        const user = users.find(item => item.id === req.params.id);

        if (!user) {
          return res.status(404).json({
            error: "Staff account not found."
          });
        }

        if (req.body?.role !== undefined) {
          if (!["manager", "staff"].includes(req.body.role)) {
            return res.status(400).json({
              error: "Staff can only be Manager or Staff."
            });
          }

          user.role = req.body.role;
          if (!Array.isArray(user.permissions)) user.permissions = [...(ROLE_PERMISSIONS[user.role] || ROLE_PERMISSIONS.staff)];
        }

        if (req.body?.permissions !== undefined) {
          const permissions = validatePermissions(req.body.permissions);
          if (permissions === null) return res.status(400).json({ error: "One or more permissions are invalid." });
          user.permissions = permissions;
        }

        if (req.body?.active !== undefined) {
          user.active = Boolean(req.body.active);
        }

        let passwordChanged = false;

        if (req.body?.password !== undefined) {
          if (
            typeof req.body.password !== "string" ||
            req.body.password.length < 10
          ) {
            return res.status(400).json({
              error: "New password must be at least 10 characters."
            });
          }

          const hashed = hashPassword(req.body.password);
          user.salt = hashed.salt;
          user.passwordHash = hashed.hash;
          passwordChanged = true;
        }

        await putStaff(user);

        if (!user.active || passwordChanged) {
          await pool.query(
            `DELETE FROM user_sessions
             WHERE sess::text LIKE $1`,
            [`%${user.id}%`]
          );
        }

        await audit(req.adminSession, "staff.updated", {
          staffId: user.id,
          passwordChanged
        });

        res.json({ ok: true, staff: publicStaff(user) });
      } catch (error) {
        next(error);
      }
    }
  );

  app.delete(
    "/api/admin/staff/:id",
    requireAdmin,
    requireOwner,
    async (req, res, next) => {
      try {
        const users = await getStaff();
        const user = users.find(item => item.id === req.params.id);

        if (!user) {
          return res.status(404).json({
            error: "Staff account not found."
          });
        }

        await removeStaff(user.id);

        await pool.query(
          `DELETE FROM user_sessions
           WHERE sess::text LIKE $1`,
          [`%${user.id}%`]
        );

        await audit(req.adminSession, "staff.deleted", {
          staffId: user.id
        });

        res.json({ ok: true });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/admin/audit",
    requireAdmin,
    requirePermission("audit.view"),
    async (_req, res, next) => {
      try {
        const result = await pool.query(
          `SELECT id, actor, role, action, details, created_at AS at
           FROM audit_logs
           ORDER BY id DESC
           LIMIT 100`
        );

        res.json({ events: result.rows });
      } catch (error) {
        next(error);
      }
    }
  );
};
