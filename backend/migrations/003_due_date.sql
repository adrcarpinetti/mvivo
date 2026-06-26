
-- Adiciona campo de vencimento na conta Vivo
ALTER TABLE vivo_accounts ADD COLUMN IF NOT EXISTS due_date DATE;
