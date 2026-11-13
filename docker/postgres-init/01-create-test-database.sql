-- Runs once, when the Postgres data volume is first initialised (docker-entrypoint-initdb.d).
-- The image already creates the `hookdeck` database from POSTGRES_DB.
-- Integration tests use a second database so they never touch development data
-- (docs/TESTING.md#getting-postgres-and-redis).
CREATE DATABASE hookdeck_test;
