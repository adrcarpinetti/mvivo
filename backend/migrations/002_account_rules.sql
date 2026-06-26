
-- Adiciona vínculo de conta à regra de rateio
ALTER TABLE allocation_rules
  ADD COLUMN IF NOT EXISTS account_number VARCHAR(20),
  ADD COLUMN IF NOT EXISTS account_numbers TEXT[]; -- múltiplas contas
-- NULL = aplica a todas as contas (regra global)
-- account_number = aplica só a essa conta
