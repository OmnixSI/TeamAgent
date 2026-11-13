-- First deploy with bili.media.enabled=false. Run this before deploying the
-- pre-ASR Worker: its generic job consumers do not exclude bili_media.
-- Replaying this UPDATE is safe. Keep video_waits.phase for forward migration.
UPDATE jobs SET status='cancelled',error='rollback'
WHERE kind='bili_media' AND status IN ('pending','running');
