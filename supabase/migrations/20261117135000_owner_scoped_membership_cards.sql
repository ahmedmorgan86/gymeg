-- Membership barcodes are scoped to a club. A single club must not be able to
-- reuse a code, but two clubs may legitimately issue the same printed number.
-- Safe to replay: the old single-column key is replaced only when present.
DO $$
BEGIN
 IF EXISTS(
  SELECT 1 FROM pg_constraint
  WHERE conrelid='gymos.membership_cards'::regclass
    AND conname='membership_cards_pkey' AND contype='p' AND cardinality(conkey)=1
 ) THEN
  ALTER TABLE gymos.membership_cards DROP CONSTRAINT membership_cards_pkey;
 END IF;
 IF NOT EXISTS(
  SELECT 1 FROM pg_constraint
  WHERE conrelid='gymos.membership_cards'::regclass
    AND conname='membership_cards_pkey' AND contype='p' AND cardinality(conkey)=2
 ) THEN
  ALTER TABLE gymos.membership_cards ADD CONSTRAINT membership_cards_pkey PRIMARY KEY(owner_id,code);
 END IF;
END $$;
