require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const logger = require('./utils/logger');

const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const costCentersRoutes = require('./routes/costCenters');
const importRoutes = require('./routes/imports');
const allocationsRoutes = require('./routes/allocations');
const reportsRoutes = require('./routes/reports');
const auditRoutes = require('./routes/audit');
const rulesRoutes = require('./routes/rules');
const linesRoutes = require('./routes/lines');

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Logs de requisição
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, { query: req.query });
  next();
});

// Rotas
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/cost-centers', costCentersRoutes);
app.use('/api/imports', importRoutes);
app.use('/api/allocations', allocationsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/rules', rulesRoutes);
app.use('/api/lines', linesRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Handler de erros global
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(err.status || 500).json({
    error: err.message || 'Erro interno do servidor',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

app.listen(PORT, () => {
  logger.info(`Servidor iniciado na porta ${PORT}`);
});

module.exports = app;
