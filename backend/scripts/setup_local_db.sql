-- One-time local setup. Run as a Postgres superuser:
--   psql -U postgres -h localhost -f scripts/setup_local_db.sql
-- Creates the app role and the dev + test databases (safe to re-run).
SELECT 'CREATE ROLE dukaanos LOGIN CREATEDB PASSWORD ''dukaanos'''
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dukaanos')\gexec

SELECT 'CREATE DATABASE dukaanos OWNER dukaanos'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'dukaanos')\gexec

SELECT 'CREATE DATABASE dukaanos_test OWNER dukaanos'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'dukaanos_test')\gexec
