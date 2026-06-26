#!/bin/bash
# ============================================================
# Setup completo — Vivo Rateio em Ubuntu
# Execute como root ou com sudo: bash setup.sh
# ============================================================
set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!!]${NC} $1"; }
err()  { echo -e "${RED}[ERR]${NC} $1"; exit 1; }

echo ""
echo "=========================================="
echo "   Vivo Rateio — Instalação Automática"
echo "=========================================="
echo ""

# ---------- 1. Node.js 20 ----------
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 18 ]]; then
  warn "Instalando Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
log "Node.js $(node -v)"

# ---------- 2. PostgreSQL ----------
if ! command -v psql &>/dev/null; then
  warn "Instalando PostgreSQL..."
  apt-get install -y postgresql postgresql-contrib
fi
systemctl enable postgresql
systemctl start postgresql
log "PostgreSQL $(psql --version | awk '{print $3}')"

# ---------- 3. Banco de dados ----------
warn "Configurando banco de dados..."
DB_PASS="vivoRateio$(openssl rand -hex 4)!"
# Cria usuário e banco (ignora erro se já existir)
sudo -u postgres psql -c "CREATE USER vivo_user WITH PASSWORD '${DB_PASS}';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE vivo_rateio OWNER vivo_user;" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE vivo_rateio TO vivo_user;" 2>/dev/null || true
log "Banco criado (usuário: vivo_user)"

# ---------- 4. Diretório da aplicação ----------
APP_DIR="/opt/vivo-rateio"
mkdir -p "$APP_DIR"

# Copia o backend (ajuste o caminho se necessário)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp -r "$SCRIPT_DIR/backend/." "$APP_DIR/"
mkdir -p "$APP_DIR/uploads" "$APP_DIR/logs"

# ---------- 5. .env ----------
JWT_SECRET=$(openssl rand -hex 32)
cat > "$APP_DIR/.env" << ENV
NODE_ENV=production
PORT=3001
DATABASE_URL=postgresql://vivo_user:${DB_PASS}@localhost:5432/vivo_rateio
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=8h
UPLOAD_DIR=/opt/vivo-rateio/uploads
LOG_LEVEL=info
LOG_DIR=/opt/vivo-rateio/logs
ENV
log ".env gerado"

# ---------- 6. npm install ----------
warn "Instalando dependências Node.js..."
cd "$APP_DIR" && npm install --production
log "Dependências instaladas"

# ---------- 7. Migrations ----------
warn "Executando migrations..."
PGPASSWORD="$DB_PASS" psql -U vivo_user -h localhost -d vivo_rateio \
  -f "$SCRIPT_DIR/backend/migrations/001_schema.sql"
log "Schema criado"

# ---------- 8. Systemd service ----------
cat > /etc/systemd/system/vivo-rateio.service << SERVICE
[Unit]
Description=Vivo Rateio API
After=network.target postgresql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/vivo-rateio
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/opt/vivo-rateio/.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICE

chown -R www-data:www-data "$APP_DIR"
systemctl daemon-reload
systemctl enable vivo-rateio
systemctl restart vivo-rateio
log "Serviço iniciado"

# ---------- 9. Nginx (opcional, porta 80) ----------
if command -v nginx &>/dev/null || apt-get install -y nginx 2>/dev/null; then
  cat > /etc/nginx/sites-available/vivo-rateio << NGINX
server {
    listen 80;
    server_name _;

    # Frontend estático
    root /opt/vivo-rateio/public;
    index index.html;

    # API → backend Node.js
    location /api/ {
        proxy_pass http://localhost:3001/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        client_max_body_size 100M;
    }

    # SPA fallback
    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
NGINX

  # Copia o frontend para a pasta pública
  mkdir -p /opt/vivo-rateio/public
  cp "$SCRIPT_DIR/index.html" /opt/vivo-rateio/public/index.html

  ln -sf /etc/nginx/sites-available/vivo-rateio /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl restart nginx
  log "Nginx configurado"
fi

# ---------- 10. Resumo ----------
IP=$(hostname -I | awk '{print $1}')
echo ""
echo "=========================================="
echo -e "${GREEN}   Instalação concluída!${NC}"
echo "=========================================="
echo ""
echo "  URL local:    http://${IP}"
echo "  API:          http://${IP}/api"
echo "  Login:        admin@empresa.com.br"
echo "  Senha:        Admin@123"
echo ""
echo "  Banco:        vivo_rateio"
echo "  DB usuário:   vivo_user"
echo "  DB senha:     ${DB_PASS}  ← GUARDE ISSO"
echo ""
echo "  Logs API:     journalctl -u vivo-rateio -f"
echo "  Status:       systemctl status vivo-rateio"
echo ""
