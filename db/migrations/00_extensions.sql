-- 00_extensions.sql
-- Required PostgreSQL extensions for the ERMP schema.
-- Safe to re-run.

create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";
create extension if not exists "citext";
create extension if not exists "pg_trgm";
