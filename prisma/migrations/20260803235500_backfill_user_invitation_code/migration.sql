-- Every user who existed before the invitation gate did gets grandfathered in under the one code
-- that was live at the time this shipped — they already proved they belonged before the gate
-- existed to ask. Only touches rows the column migration just left NULL; never overwrites a real
-- value a later join may have already recorded.
UPDATE "User" SET "invitationCode" = 'mackie' WHERE "invitationCode" IS NULL;
