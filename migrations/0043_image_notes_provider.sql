-- Columns are ensured idempotently by ensureImageNotesProvider in migrate.mjs.
-- sha encodes (image hash, actual provider, actual model, version) for unambiguous links.
UPDATE image_notes SET provider='workers_ai' WHERE provider IS NULL OR provider='';
UPDATE image_notes SET model='@cf/meta/llama-3.2-11b-vision-instruct' WHERE model IS NULL OR model='';
CREATE UNIQUE INDEX IF NOT EXISTS image_notes_provider_model ON image_notes(sha,provider,model);
