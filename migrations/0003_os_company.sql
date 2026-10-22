-- Map a worker-f workspace (app_users.company_id, for example co-ada-acme-com) to its Semanto
-- trooth_id, so the /os routes authorize through worker-f's GET /auth/session without guessing.
ALTER TABLE semanto_companies ADD COLUMN os_company_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS semanto_companies_os_company ON semanto_companies(os_company_id);
