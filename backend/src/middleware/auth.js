// middleware/auth.js
const jwt = require('jsonwebtoken');
const { query } = require('../utils/db');

const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Token não fornecido' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userRes = await query(
      'SELECT u.*, r.name as role_name, r.permissions FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND u.active = TRUE',
      [decoded.userId]
    );

    if (userRes.rows.length === 0) {
      return res.status(401).json({ error: 'Usuário não encontrado ou inativo' });
    }

    req.user = userRes.rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
};

const requirePermission = (permission) => (req, res, next) => {
  const perms = req.user?.permissions || {};
  if (perms.all || perms[permission]) return next();
  return res.status(403).json({ error: 'Acesso negado. Permissão insuficiente.' });
};

module.exports = { authenticate, requirePermission };
