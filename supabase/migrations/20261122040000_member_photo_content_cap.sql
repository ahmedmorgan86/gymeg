-- Widen gymos.gym_photos content CHECK from 22,000 to 96,000 data-URL characters,
-- matching the member-photo contract (MEMBER_PHOTO_MAX in app/lib/member-photo-input.ts,
-- 320px JPEG q0.85). Without this, photos the app/domain/backup bound accepts fail SQL
-- persistence and entity restore with 23514 gym_photos_content_check.
ALTER TABLE gymos.gym_photos DROP CONSTRAINT IF EXISTS gym_photos_content_check;
ALTER TABLE gymos.gym_photos ADD CONSTRAINT gym_photos_content_check CHECK(length(content)<=96000);
