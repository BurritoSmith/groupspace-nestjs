-- Seed the shared invitation code. ON CONFLICT DO NOTHING so this migration stays safe to have
-- existed even if the row was already created some other way (e.g. manually, before this ran).
INSERT INTO "Invitation" ("id", "code") VALUES (gen_random_uuid(), 'mackie') ON CONFLICT ("code") DO NOTHING;
