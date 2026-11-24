-- Application amount() checks are not sufficient when a JSON state can be
-- written directly by an import, an operator tool or a future API path.
CREATE OR REPLACE FUNCTION gymos.gym_state_payment_amount_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE doc jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 BEGIN
  doc:=NEW.payload::jsonb;
 EXCEPTION WHEN invalid_text_representation THEN
  RETURN NEW; -- Legacy non-JSON rows are handled by the application migration path.
 END;
 IF jsonb_typeof(doc->'payments')='array' AND EXISTS(
   SELECT 1 FROM jsonb_array_elements(doc->'payments') payment
   WHERE payment->'minor' IS NULL OR jsonb_typeof(payment->'minor')<>'number'
      OR (payment->>'minor')::numeric<=0
      OR (payment->>'minor')::numeric>10000000000
      OR (payment->>'minor')::numeric<>trunc((payment->>'minor')::numeric)
 ) THEN
  RAISE EXCEPTION 'invalidPaymentAmount' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS gym_state_payment_amount_guard ON gymos.gym_states;
CREATE TRIGGER gym_state_payment_amount_guard BEFORE INSERT OR UPDATE OF payload ON gymos.gym_states
 FOR EACH ROW EXECUTE FUNCTION gymos.gym_state_payment_amount_guard();
REVOKE ALL ON FUNCTION gymos.gym_state_payment_amount_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION gymos.gym_state_payment_amount_guard() TO gymos_app;
