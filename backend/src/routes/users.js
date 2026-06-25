// routes/users.js
const express = require('express');
const bcrypt = require('bcryptjs');
const { authenticate, requirePermission } = require('../middleware/auth');
const { query } = require('../utils/db');
const router = express.Router();

// GET /api/users
router.get('/', authenticate, requirePermission('all'), async (req, res) => {
  try {
    const result = await query(`
      SELECT u.id, u.name, u.email, u.active, u.last_login, u.created_at,
             r.name as role_name, r.id as role_id
      FROM users u
      JOIN roles r ON r.id = u.role_id
      ORDER BY u.name
    `);
    res.json({ users: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/users
router.post('/', authenticate, requirePermission('all'), async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Campos obrigatórios: name, email, password' });

    // Resolve role_id pelo nome do perfil (admin/analyst/viewer/auditor)
    const roleRes = await query('SELECT id FROM roles WHERE name = $1', [role || 'analyst']);
    if (roleRes.rows.length === 0) return res.status(400).json({ error: `Perfil '${role}' não encontrado` });
    const roleId = roleRes.rows[0].id;

    const hash = await bcrypt.hash(password, 10);
    const result = await query(
      'INSERT INTO users (name, email, password_hash, role_id) VALUES ($1,$2,$3,$4) RETURNING id,name,email',
      [name, email.toLowerCase(), hash, roleId]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'E-mail já cadastrado' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/:id
router.put('/:id', authenticate, requirePermission('all'), async (req, res) => {
  try {
    const { name, email, active, role, password } = req.body;

    // Resolve role_id
    let roleId;
    if (role) {
      const roleRes = await query('SELECT id FROM roles WHERE name = $1', [role]);
      if (roleRes.rows.length > 0) roleId = roleRes.rows[0].id;
    }

    // Atualiza com ou sem senha
    let result;
    if (password && password.trim()) {
      const hash = await bcrypt.hash(password, 10);
      result = await query(
        'UPDATE users SET name=$1, email=$2, active=COALESCE($3,true), role_id=COALESCE($4,role_id), password_hash=$5, updated_at=NOW() WHERE id=$6 RETURNING id,name,email,active',
        [name, email.toLowerCase(), active, roleId, hash, req.params.id]
      );
    } else {
      result = await query(
        'UPDATE users SET name=$1, email=$2, active=COALESCE($3,true), role_id=COALESCE($4,role_id), updated_at=NOW() WHERE id=$5 RETURNING id,name,email,active',
        [name, email.toLowerCase(), active, roleId, req.params.id]
      );
    }

    if (result.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'E-mail já cadastrado' });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/roles
router.get('/roles', authenticate, async (req, res) => {
  const result = await query('SELECT id, name, description FROM roles ORDER BY name');
  res.json({ roles: result.rows });
});

// DELETE /api/users/:id (desativação lógica)
router.delete('/:id', authenticate, requirePermission('all'), async (req, res) => {
  try {
    await query('UPDATE users SET active=false, updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ message: 'Usuário desativado' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
