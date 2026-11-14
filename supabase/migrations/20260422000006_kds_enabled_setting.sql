-- Add kds_enabled to receipt settings JSON blob
UPDATE settings
SET value = value || '{"kds_enabled": false}'::jsonb
WHERE key = 'receipt';
