# 📱 Vivo Rateio — Sistema de Rateio de Contas Telefônicas Corporativas

Sistema web completo para controle, conferência e rateio das contas Vivo corporativas por centro de custo.

## ✨ Funcionalidades

- **📤 Importação** de arquivos Vivo (.ZIP/.TXT posicional) e GOC (.CSV)
- **🧮 Simulação** de rateio com prévia antes de confirmar
- **⚡ Rateio automático** por centro de custo com regras configuráveis
- **🔎 Conferência** Vivo × GOC — divergências, linhas sem CC, apenas na Vivo
- **📈 Relatórios** mensais, por CC, por linha e comparação entre meses
- **📱 Gestão de linhas** com histórico mensal completo
- **🔒 Fechamento mensal** com auditoria completa
- **👥 Gestão de usuários** com perfis: Admin, Analista, Consulta, Auditoria

## 🏗️ Arquitetura

```
backend/          Node.js + Express + PostgreSQL
  src/
    parsers/      vivoParser.js · gocParser.js
    services/     allocationService.js (lógica de rateio)
    routes/       auth · users · imports · allocations · reports · rules · audit
    middleware/   auth.js (JWT + permissões por role)
    utils/        db.js (Pool PG) · logger.js (Winston)
  migrations/
    001_schema.sql    Schema PostgreSQL completo

frontend/
  vivo-rateio-app.html   SPA React self-contained (sem bundler)
```

## 🚀 Instalação Rápida

### Com Docker (recomendado)

```bash
# 1. Clone e configure
cp backend/.env.example backend/.env
# Edite backend/.env com suas configurações

# 2. Suba os containers
docker-compose up -d

# 3. Acesse
# API:      http://localhost:3001
# Frontend: Abra vivo-rateio-app.html no navegador
```

### Sem Docker

```bash
# PostgreSQL
createdb vivo_rateio
createuser vivo_user
psql vivo_rateio < backend/migrations/001_schema.sql

# Backend
cd backend
cp .env.example .env    # configure DATABASE_URL e JWT_SECRET
npm install
npm start

# Frontend
# Abra o arquivo frontend/vivo-rateio-app.html no navegador
# Configure a URL da API em Settings se necessário
```

## 👤 Acesso inicial

| Campo  | Valor                    |
|--------|--------------------------|
| Email  | admin@empresa.com.br     |
| Senha  | Admin@123                |

> ⚠️ Troque a senha do admin imediatamente após o primeiro acesso.

## 📁 Formatos de arquivo suportados

### Arquivo Vivo
- Formato: `.TXT` posicional (dentro de `.ZIP`) — encoding latin-1/ISO-8859-1
- Nomenclatura: `VIVO_[CONTA]_[MMYY].ZIP`
- Posições chave: conta (0-13), assinatura (14-28), telefone (29-43), segmento (105-119), valor (165-194)

### Arquivo GOC
- Formato: `.CSV` com separador `;` — encoding latin-1
- Colunas obrigatórias: `LINHA`, `NUMERO_CONTA`, `COD_CENTRO_CUSTO`, `CENTRO_CUSTO`

## ⚙️ Regras de rateio

Tipos disponíveis:
- **Proporcional por linhas** — distribui pelo número de linhas ativas por CC
- **Proporcional por valor** — distribui pelo valor direto de cada CC
- **Percentual fixo** — percentuais manuais por CC
- **Manual** — valores fixos por CC
- **Por tipo de cobrança** — regras específicas por categoria

## 🔐 Perfis de acesso

| Perfil    | Permissões                                              |
|-----------|--------------------------------------------------------|
| Admin     | Tudo — incluindo usuários e reabertura de meses         |
| Analista  | Importar, processar rateios, fechar mês, exportar      |
| Consulta  | Visualizar dashboards e relatórios (somente leitura)   |
| Auditoria | Logs de auditoria, relatórios e conferência            |

## 📊 Tabelas do banco

`roles` · `users` · `cost_centers` · `phone_lines` · `vivo_accounts` · `vivo_invoice_items` · `goc_imports` · `goc_import_items` · `allocation_rules` · `monthly_allocations` · `allocation_items` · `audit_logs` · `import_logs`

Views: `vw_line_reconciliation` · `vw_allocation_dashboard`
