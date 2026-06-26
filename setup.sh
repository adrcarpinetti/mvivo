#!/bin/bash
# ============================================================
# Setup completo — Vivo Rateio em Ubuntu 22.04
# Execute: sudo bash setup.sh
# ============================================================
set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!!]${NC} $1"; }
err()  { echo -e "${RED}[ERRO]${NC} $1"; exit 1; }

echo ""
echo "=========================================="
echo "   Vivo Rateio — Instalação Automática"
echo "=========================================="
echo ""

# ---------- 1. curl e dependências básicas ----------
warn "Instalando curl e dependências..."
apt-get install -y curl wget ca-certificates gnupg lsb-release openssl
log "curl instalado"

# ---------- 2. Node.js 20 (via NodeSource) ----------
warn "Instalando Node.js 20..."
# Remove versão antiga se existir
apt-get remove -y nodejs 2>/dev/null || true
apt-get autoremove -y 2>/dev/null || true

# Instala via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

NODE_VER=$(node -v)
NPM_VER=$(npm -v)
log "Node.js $NODE_VER / npm $NPM_VER"

# Verifica versão mínima
MAJOR=$(echo $NODE_VER | cut -d. -f1 | tr -d 'v')
[ "$MAJOR" -lt 18 ] && err "Node.js $NODE_VER muito antigo. Esperado >= 18."

# ---------- 3. PostgreSQL ----------
if ! command -v psql &>/dev/null; then
  warn "Instalando PostgreSQL..."
  apt-get install -y postgresql postgresql-contrib
fi
systemctl enable postgresql
systemctl start postgresql
log "PostgreSQL $(psql --version | awk '{print $3}')"

# ---------- 4. Banco de dados ----------
warn "Configurando banco de dados..."
DB_PASS="vivoRateio$(openssl rand -hex 4)!"

sudo -u postgres psql -c "CREATE USER vivo_user WITH PASSWORD '${DB_PASS}';" 2>/dev/null || \
  sudo -u postgres psql -c "ALTER USER vivo_user WITH PASSWORD '${DB_PASS}';"

sudo -u postgres psql -c "CREATE DATABASE vivo_rateio OWNER vivo_user;" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE vivo_rateio TO vivo_user;" 2>/dev/null || true
log "Banco configurado (vivo_rateio / vivo_user)"

# ---------- 5. Diretório da aplicação ----------
APP_DIR="/opt/vivo-rateio"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$APP_DIR"
cp -r "$SCRIPT_DIR/backend/." "$APP_DIR/"
mkdir -p "$APP_DIR/uploads" "$APP_DIR/logs"

# ---------- 6. .env ----------
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

# ---------- 7. npm install ----------
warn "Instalando dependências Node.js..."
cd "$APP_DIR"
npm install --production
log "Dependências instaladas"

# ---------- 8. Migrations ----------
warn "Executando migrations..."
PGPASSWORD="$DB_PASS" psql -U vivo_user -h localhost -d vivo_rateio \
  -f "$SCRIPT_DIR/backend/migrations/001_schema.sql"
log "Schema criado"

# ---------- 9. Nginx ----------
warn "Instalando Nginx..."
apt-get install -y nginx

# Copia frontend
mkdir -p /opt/vivo-rateio/public
cp "$SCRIPT_DIR/index.html" /opt/vivo-rateio/public/index.html

cat > /etc/nginx/sites-available/vivo-rateio << 'NGINX'
server {
    listen 80 default_server;
    server_name _;

    root /opt/vivo-rateio/public;
    index index.html;

    # API → Node.js backend
    location /api/ {
        proxy_pass http://127.0.0.1:3001/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
        client_max_body_size 100M;
    }

    # SPA — tudo vai pro index.html
    location / {
        try_files $uri $uri/ /index.html;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/vivo-rateio /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl enable nginx && systemctl restart nginx
log "Nginx configurado"

# ---------- 10. Systemd service ----------
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
sleep 3

# Verifica se subiu
if systemctl is-active --quiet vivo-rateio; then
  log "Serviço vivo-rateio iniciado"
else
  warn "Serviço com problema — veja: journalctl -u vivo-rateio -n 30"
fi

# ---------- 11. Resumo ----------
IP=$(hostname -I | awk '{print $1}')
echo ""
echo "=========================================="
echo -e "${GREEN}   Instalação concluída!${NC}"
echo "=========================================="
echo ""
echo "  Acesse:       http://${IP}"
echo "  Login:        admin@empresa.com.br"
echo "  Senha:        Admin@123"
echo ""
echo "  DB senha:     ${DB_PASS}  ← GUARDE ISSO"
echo ""
echo "  Ver logs:     journalctl -u vivo-rateio -f"
echo "  Status:       systemctl status vivo-rateio"
echo ""
