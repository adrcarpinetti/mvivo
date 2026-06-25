const express = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { query } = require('../utils/db');
const router = express.Router();

router.get('/', authenticate, requirePermission('audit'), async (req, res) => {
  try {
    const { action, entity, userId, page = 1, limit = 50 } = req.query;
    const params = [];
    let where = 'WHERE 1=1';

    if (action) { params.push(action); where += ` AND al.action = $${params.length}`; }
    if (entity) { params.push(entity); where += ` AND al.entity_type = $${params.length}`; }
    if (userId) { params.push(userId); where += ` AND al.user_id = $${params.length}`; }

    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
    const result = await query(`
      SELECT al.*, u.name as user_name
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.user_id
      ${where}
      ORDER BY al.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json({ logs: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
