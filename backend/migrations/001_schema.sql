-- ============================================================
-- VIVO RATEIO - Schema PostgreSQL Completo
-- ============================================================

-- Extensões úteis
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- ============================================================
-- USUÁRIOS E PERMISSÕES
-- ============================================================

CREATE TABLE roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    description TEXT,
    permissions JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(150) NOT NULL,
    email VARCHAR(200) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role_id INTEGER REFERENCES roles(id),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    last_login TIMESTAMP WITH TIME ZONE,
    password_reset_token VARCHAR(255),
    password_reset_expires TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- CENTROS DE CUSTO
-- ============================================================

CREATE TABLE cost_centers (
    id SERIAL PRIMARY KEY,
    code VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_cost_centers_code ON cost_centers(code);
CREATE INDEX idx_cost_centers_active ON cost_centers(active);

-- ============================================================
-- CONTAS VIVO (INVOICES)
-- ============================================================

CREATE TABLE vivo_accounts (
    id SERIAL PRIMARY KEY,
    account_number VARCHAR(20) NOT NULL,
    reference_month DATE NOT NULL, -- primeiro dia do mês de referência
    cnpj VARCHAR(20),
    company_name VARCHAR(200),
    total_amount NUMERIC(15,2),
    status VARCHAR(20) NOT NULL DEFAULT 'imported'
        CHECK (status IN ('imported','processing','reviewing','closed','reopened')),
    closed_at TIMESTAMP WITH TIME ZONE,
    closed_by UUID REFERENCES users(id),
    reopen_reason TEXT,
    file_name VARCHAR(255),
    file_size INTEGER,
    import_log_id INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(account_number, reference_month)
);

CREATE INDEX idx_vivo_accounts_reference_month ON vivo_accounts(reference_month);
CREATE INDEX idx_vivo_accounts_status ON vivo_accounts(status);
CREATE INDEX idx_vivo_accounts_account_number ON vivo_accounts(account_number);

-- ============================================================
-- LINHAS TELEFÔNICAS
-- ============================================================

CREATE TABLE phone_lines (
    id SERIAL PRIMARY KEY,
    number VARCHAR(20) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    first_seen_date DATE,
    last_seen_date DATE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(number)
);

CREATE INDEX idx_phone_lines_number ON phone_lines(number);
CREATE INDEX idx_phone_lines_active ON phone_lines(active);

-- ============================================================
-- IMPORTAÇÕES GOC
-- ============================================================

CREATE TABLE goc_imports (
    id SERIAL PRIMARY KEY,
    reference_month DATE NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_size INTEGER,
    total_lines INTEGER DEFAULT 0,
    valid_lines INTEGER DEFAULT 0,
    invalid_lines INTEGER DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','processing','completed','failed')),
    imported_by UUID REFERENCES users(id),
    error_details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE goc_import_items (
    id SERIAL PRIMARY KEY,
    goc_import_id INTEGER NOT NULL REFERENCES goc_imports(id) ON DELETE CASCADE,
    phone_line_id INTEGER REFERENCES phone_lines(id),
    cost_center_id INTEGER REFERENCES cost_centers(id),
    phone_number VARCHAR(20) NOT NULL,
    cost_center_code VARCHAR(20),
    cost_center_name VARCHAR(200),
    employee_name VARCHAR(200),
    employee_id VARCHAR(50),
    cpf VARCHAR(20),
    active BOOLEAN,
    delivery_date DATE,
    return_date DATE,
    plan_type VARCHAR(100),
    line_type VARCHAR(50),
    reference_value NUMERIC(10,2),
    activation_date DATE,
    contract_end_date DATE,
    account_number VARCHAR(20),
    cnpj VARCHAR(20),
    active_services TEXT,
    raw_data JSONB,
    is_valid BOOLEAN DEFAULT TRUE,
    validation_errors JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_goc_items_import ON goc_import_items(goc_import_id);
CREATE INDEX idx_goc_items_phone ON goc_import_items(phone_number);
CREATE INDEX idx_goc_items_cc ON goc_import_items(cost_center_id);

-- ============================================================
-- IMPORTAÇÕES VIVO - ITENS DA FATURA
-- ============================================================

CREATE TABLE vivo_invoice_items (
    id SERIAL PRIMARY KEY,
    vivo_account_id INTEGER NOT NULL REFERENCES vivo_accounts(id) ON DELETE CASCADE,
    phone_line_id INTEGER REFERENCES phone_lines(id),
    
    -- Identificação
    account_number VARCHAR(20),
    line_number VARCHAR(20),
    subscription_code VARCHAR(30),
    
    -- Tipo de registro (segmento do arquivo TXT da Vivo)
    record_type VARCHAR(10),
    segment_code VARCHAR(10),
    
    -- Categorização do item
    item_category VARCHAR(50), -- 'monthly_fee', 'usage', 'tax', 'adjustment', 'other'
    description VARCHAR(500),
    service_code VARCHAR(100),
    
    -- Valores
    amount NUMERIC(12,2) DEFAULT 0,
    quantity NUMERIC(12,4),
    unit VARCHAR(20),
    
    -- Flags
    is_shared BOOLEAN DEFAULT FALSE, -- linha compartilhada entre CCs
    has_cost_center BOOLEAN DEFAULT FALSE,
    
    -- Rateio
    cost_center_id INTEGER REFERENCES cost_centers(id),
    allocation_note TEXT,
    
    raw_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_invoice_items_account ON vivo_invoice_items(vivo_account_id);
CREATE INDEX idx_invoice_items_phone ON vivo_invoice_items(phone_line_id);
CREATE INDEX idx_invoice_items_cc ON vivo_invoice_items(cost_center_id);
CREATE INDEX idx_invoice_items_category ON vivo_invoice_items(item_category);

-- ============================================================
-- REGRAS DE RATEIO
-- ============================================================

CREATE TABLE allocation_rules (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    rule_type VARCHAR(50) NOT NULL
        CHECK (rule_type IN (
            'proportional_lines',     -- proporcional à quantidade de linhas
            'proportional_value',     -- proporcional ao valor total
            'fixed_percentage',       -- percentual fixo definido manualmente
            'manual',                 -- valor manual por CC
            'by_charge_type',         -- por tipo de cobrança
            'specific'                -- regra específica
        )),
    applies_to VARCHAR(50) DEFAULT 'unallocated'
        CHECK (applies_to IN ('unallocated', 'all', 'specific_charge', 'tax', 'adjustment', 'fine')),
    charge_type_filter VARCHAR(100), -- filtro para applies_to = 'specific_charge'
    
    -- Vigência
    valid_from DATE NOT NULL,
    valid_until DATE,
    
    -- Prioridade (menor = maior prioridade)
    priority INTEGER NOT NULL DEFAULT 10,
    
    -- Configuração específica por tipo de regra
    config JSONB NOT NULL DEFAULT '{}',
    -- Para 'fixed_percentage': {"cost_centers": [{"id": 1, "percentage": 30.5}, ...]}
    -- Para 'manual': {"cost_centers": [{"id": 1, "amount": 500.00}, ...]}
    -- Para 'specific': configuração livre
    
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_allocation_rules_active ON allocation_rules(active);
CREATE INDEX idx_allocation_rules_valid ON allocation_rules(valid_from, valid_until);

-- ============================================================
-- RATEIO MENSAL
-- ============================================================

CREATE TABLE monthly_allocations (
    id SERIAL PRIMARY KEY,
    vivo_account_id INTEGER NOT NULL REFERENCES vivo_accounts(id),
    reference_month DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'simulated', 'confirmed', 'closed')),
    
    -- Totais da conta
    total_invoice_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    total_allocated_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    total_unallocated_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    difference NUMERIC(15,2) GENERATED ALWAYS AS (total_invoice_amount - total_allocated_amount) STORED,
    
    -- Estatísticas
    total_lines INTEGER DEFAULT 0,
    lines_with_cc INTEGER DEFAULT 0,
    lines_without_cc INTEGER DEFAULT 0,
    lines_in_vivo_not_goc INTEGER DEFAULT 0,
    lines_in_goc_not_vivo INTEGER DEFAULT 0,
    
    -- Regras aplicadas
    rules_applied JSONB DEFAULT '[]',
    
    -- Fechamento
    confirmed_by UUID REFERENCES users(id),
    confirmed_at TIMESTAMP WITH TIME ZONE,
    closed_by UUID REFERENCES users(id),
    closed_at TIMESTAMP WITH TIME ZONE,
    
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(vivo_account_id)
);

CREATE TABLE allocation_items (
    id SERIAL PRIMARY KEY,
    monthly_allocation_id INTEGER NOT NULL REFERENCES monthly_allocations(id) ON DELETE CASCADE,
    cost_center_id INTEGER NOT NULL REFERENCES cost_centers(id),
    
    -- Valores diretos (linhas com CC identificado)
    direct_amount NUMERIC(12,2) DEFAULT 0,
    direct_line_count INTEGER DEFAULT 0,
    
    -- Valores rateados (de linhas sem CC, impostos, etc.)
    allocated_amount NUMERIC(12,2) DEFAULT 0,
    allocation_rule_id INTEGER REFERENCES allocation_rules(id),
    allocation_percentage NUMERIC(8,4),
    
    -- Total
    total_amount NUMERIC(12,2) GENERATED ALWAYS AS (direct_amount + allocated_amount) STORED,
    
    -- Detalhes para auditoria
    details JSONB DEFAULT '{}',
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(monthly_allocation_id, cost_center_id)
);

CREATE INDEX idx_allocation_items_alloc ON allocation_items(monthly_allocation_id);
CREATE INDEX idx_allocation_items_cc ON allocation_items(cost_center_id);

-- ============================================================
-- LOGS DE AUDITORIA
-- ============================================================

CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    user_name VARCHAR(200),
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100),
    entity_id VARCHAR(100),
    old_values JSONB,
    new_values JSONB,
    description TEXT,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at DESC);

-- ============================================================
-- LOGS DE IMPORTAÇÃO
-- ============================================================

CREATE TABLE import_logs (
    id SERIAL PRIMARY KEY,
    import_type VARCHAR(50) NOT NULL CHECK (import_type IN ('vivo','goc','historical')),
    file_name VARCHAR(255) NOT NULL,
    file_size INTEGER,
    reference_month DATE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','processing','completed','failed','partial')),
    total_records INTEGER DEFAULT 0,
    processed_records INTEGER DEFAULT 0,
    error_records INTEGER DEFAULT 0,
    warnings JSONB DEFAULT '[]',
    errors JSONB DEFAULT '[]',
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    imported_by UUID REFERENCES users(id),
    related_id INTEGER, -- ID do vivo_account ou goc_import gerado
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_import_logs_type ON import_logs(import_type);
CREATE INDEX idx_import_logs_status ON import_logs(status);
CREATE INDEX idx_import_logs_month ON import_logs(reference_month);

-- ============================================================
-- VIEWS ÚTEIS
-- ============================================================

-- Vista para reconciliação: linhas na Vivo X GOC por mês
CREATE OR REPLACE VIEW vw_line_reconciliation AS
SELECT 
    va.reference_month,
    va.account_number,
    pl.number AS phone_number,
    vii.description,
    vii.amount,
    gi.cost_center_code,
    gi.cost_center_name,
    gi.employee_name,
    CASE 
        WHEN gi.phone_number IS NOT NULL AND vii.line_number IS NOT NULL THEN 'both'
        WHEN vii.line_number IS NOT NULL THEN 'vivo_only'
        WHEN gi.phone_number IS NOT NULL THEN 'goc_only'
    END AS presence
FROM vivo_accounts va
LEFT JOIN vivo_invoice_items vii ON vii.vivo_account_id = va.id AND vii.item_category = 'monthly_fee'
LEFT JOIN phone_lines pl ON pl.id = vii.phone_line_id
LEFT JOIN goc_import_items gi ON gi.phone_number = vii.line_number
    AND gi.account_number = va.account_number;

-- Vista para dashboard: totais por CC por mês
CREATE OR REPLACE VIEW vw_allocation_dashboard AS
SELECT 
    ma.reference_month,
    cc.code AS cost_center_code,
    cc.name AS cost_center_name,
    ai.direct_line_count,
    ai.direct_amount,
    ai.allocated_amount,
    ai.total_amount,
    ma.total_invoice_amount,
    ROUND((ai.total_amount / NULLIF(ma.total_invoice_amount, 0)) * 100, 2) AS percentage_of_total
FROM monthly_allocations ma
JOIN allocation_items ai ON ai.monthly_allocation_id = ma.id
JOIN cost_centers cc ON cc.id = ai.cost_center_id
WHERE ma.status IN ('confirmed', 'closed');

-- ============================================================
-- FUNÇÕES E TRIGGERS
-- ============================================================

-- Atualiza updated_at automaticamente
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Aplica o trigger nas tabelas relevantes
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'users', 'cost_centers', 'vivo_accounts', 'phone_lines',
        'goc_imports', 'allocation_rules', 'monthly_allocations', 'allocation_items'
    ] LOOP
        EXECUTE format('
            CREATE TRIGGER trg_%s_updated_at
            BEFORE UPDATE ON %s
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
        ', t, t);
    END LOOP;
END;
$$;

-- ============================================================
-- DADOS INICIAIS
-- ============================================================

INSERT INTO roles (name, description, permissions) VALUES
('admin', 'Administrador do sistema', '{"all": true}'),
('analyst', 'Analista financeiro', '{
    "import": true, "validate": true, "allocate": true,
    "report": true, "close_month": true
}'),
('viewer', 'Consulta apenas', '{"report": true, "view": true}'),
('auditor', 'Auditoria', '{"report": true, "view": true, "audit": true}');

-- Usuário admin padrão (senha: Admin@123)
INSERT INTO users (name, email, password_hash, role_id) VALUES
('Administrador', 'admin@empresa.com.br',
 '$2b$10$o2cJP4fN.CsdOwcTxwR61ucnIuYjtMkqzyATptv0pJo6gi4HMr81.',
 (SELECT id FROM roles WHERE name = 'admin'))
ON CONFLICT (email) DO UPDATE SET
  password_hash = EXCLUDED.password_hash;
