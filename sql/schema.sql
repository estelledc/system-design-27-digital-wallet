CREATE TABLE IF NOT EXISTS lab_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  asset text NOT NULL CHECK (asset = 'LAB'),
  treasury_wallet_id text NOT NULL CHECK (treasury_wallet_id = 'treasury'),
  genesis_supply bigint NOT NULL CHECK (genesis_supply BETWEEN 1 AND 10000000)
);

INSERT INTO lab_config(singleton, schema_version, asset, treasury_wallet_id, genesis_supply)
VALUES (true, 1, 'LAB', 'treasury', 10000000)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS authority_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  current_revision bigint NOT NULL CHECK (current_revision >= 0)
);

INSERT INTO authority_state(singleton, current_revision)
VALUES (true, 0)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS operation_receipts (
  operation text NOT NULL,
  request_key text NOT NULL,
  intent_digest character(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  completed boolean NOT NULL DEFAULT false,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (operation, request_key),
  CHECK (completed = (result IS NOT NULL)),
  CHECK ((NOT completed AND completed_at IS NULL) OR (completed AND completed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS authority_events (
  revision bigint PRIMARY KEY CHECK (revision > 0),
  event_kind text NOT NULL CHECK (event_kind IN (
    'wallet_created', 'wallet_state_changed', 'transfer_posted', 'reversal_posted'
  )),
  entity_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS wallets (
  wallet_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('treasury', 'user')),
  asset text NOT NULL CHECK (asset = 'LAB'),
  state text NOT NULL CHECK (state IN ('active', 'frozen', 'closed')),
  generation integer NOT NULL CHECK (generation > 0),
  initial_balance bigint NOT NULL CHECK (initial_balance BETWEEN 0 AND 10000000),
  balance bigint NOT NULL CHECK (balance BETWEEN 0 AND 10000000),
  balance_revision bigint NOT NULL REFERENCES authority_events(revision),
  create_intent_digest character(64) NOT NULL CHECK (create_intent_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'treasury' AND wallet_id = 'treasury' AND initial_balance > 0) OR
         (kind = 'user' AND wallet_id <> 'treasury' AND initial_balance = 0))
);

CREATE TABLE IF NOT EXISTS wallet_events (
  wallet_event_id text PRIMARY KEY,
  wallet_id text NOT NULL REFERENCES wallets(wallet_id),
  revision bigint NOT NULL UNIQUE REFERENCES authority_events(revision),
  event_kind text NOT NULL CHECK (event_kind IN ('created', 'frozen', 'activated', 'closed')),
  state text NOT NULL CHECK (state IN ('active', 'frozen', 'closed')),
  generation integer NOT NULL CHECK (generation > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (wallet_id, generation)
);

CREATE TABLE IF NOT EXISTS wallet_balance_versions (
  wallet_id text NOT NULL REFERENCES wallets(wallet_id),
  revision bigint NOT NULL REFERENCES authority_events(revision),
  balance bigint NOT NULL CHECK (balance BETWEEN 0 AND 10000000),
  cause text NOT NULL CHECK (cause IN ('genesis', 'wallet_created', 'transfer', 'reversal')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (wallet_id, revision)
);

CREATE TABLE IF NOT EXISTS transfer_intents (
  transfer_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('transfer', 'reversal')),
  original_transfer_id text REFERENCES transfer_intents(transfer_id),
  source_wallet_id text NOT NULL REFERENCES wallets(wallet_id),
  destination_wallet_id text NOT NULL REFERENCES wallets(wallet_id),
  amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 1000000),
  asset text NOT NULL CHECK (asset = 'LAB'),
  expected_source_generation integer NOT NULL CHECK (expected_source_generation > 0),
  expected_destination_generation integer NOT NULL CHECK (expected_destination_generation > 0),
  intent_digest character(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('prepared', 'posted')),
  posted_revision bigint UNIQUE REFERENCES authority_events(revision),
  journal_tx_id text UNIQUE,
  posted_result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  posted_at timestamptz,
  CHECK (source_wallet_id <> destination_wallet_id),
  CHECK ((kind = 'transfer' AND original_transfer_id IS NULL) OR
         (kind = 'reversal' AND original_transfer_id IS NOT NULL)),
  CHECK ((state = 'prepared' AND posted_revision IS NULL AND journal_tx_id IS NULL AND posted_result IS NULL AND posted_at IS NULL) OR
         (state = 'posted' AND posted_revision IS NOT NULL AND journal_tx_id IS NOT NULL AND posted_result IS NOT NULL AND posted_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS one_posted_reversal_per_original
ON transfer_intents(original_transfer_id)
WHERE kind = 'reversal';

CREATE TABLE IF NOT EXISTS journal_transactions (
  journal_tx_id text PRIMARY KEY,
  transfer_id text NOT NULL UNIQUE REFERENCES transfer_intents(transfer_id) DEFERRABLE INITIALLY DEFERRED,
  revision bigint NOT NULL UNIQUE REFERENCES authority_events(revision),
  kind text NOT NULL CHECK (kind IN ('transfer', 'reversal')),
  asset text NOT NULL CHECK (asset = 'LAB'),
  amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 1000000),
  expected_entry_count smallint NOT NULL DEFAULT 2 CHECK (expected_entry_count = 2),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS journal_entries (
  journal_entry_id text PRIMARY KEY,
  journal_tx_id text NOT NULL REFERENCES journal_transactions(journal_tx_id),
  ordinal smallint NOT NULL CHECK (ordinal IN (1, 2)),
  revision bigint NOT NULL REFERENCES authority_events(revision),
  wallet_id text NOT NULL REFERENCES wallets(wallet_id),
  side text NOT NULL CHECK (side IN ('debit', 'credit')),
  delta bigint NOT NULL CHECK (delta <> 0),
  amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 1000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (journal_tx_id, ordinal),
  UNIQUE (journal_tx_id, side),
  UNIQUE (journal_tx_id, wallet_id),
  CHECK ((side = 'debit' AND delta = -amount) OR (side = 'credit' AND delta = amount))
);

CREATE TABLE IF NOT EXISTS statements (
  statement_id text PRIMARY KEY,
  request_key text NOT NULL UNIQUE,
  intent_digest character(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  wallet_id text NOT NULL REFERENCES wallets(wallet_id),
  wallet_generation integer NOT NULL CHECK (wallet_generation > 0),
  as_of_revision bigint NOT NULL REFERENCES authority_events(revision),
  opening_balance bigint NOT NULL CHECK (opening_balance BETWEEN 0 AND 10000000),
  closing_balance bigint NOT NULL CHECK (closing_balance BETWEEN 0 AND 10000000),
  entry_count integer NOT NULL CHECK (entry_count BETWEEN 0 AND 1024),
  ordered_digest character(64) NOT NULL CHECK (ordered_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS statement_items (
  statement_id text NOT NULL REFERENCES statements(statement_id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 1024),
  journal_entry_id text NOT NULL REFERENCES journal_entries(journal_entry_id),
  authority_revision bigint NOT NULL REFERENCES authority_events(revision),
  side text NOT NULL CHECK (side IN ('debit', 'credit')),
  delta bigint NOT NULL CHECK (delta <> 0),
  resulting_balance bigint NOT NULL CHECK (resulting_balance BETWEEN 0 AND 10000000),
  PRIMARY KEY (statement_id, ordinal),
  UNIQUE (statement_id, journal_entry_id)
);

CREATE TABLE IF NOT EXISTS statement_page_receipts (
  statement_id text NOT NULL REFERENCES statements(statement_id),
  cursor_key text NOT NULL,
  page_limit integer NOT NULL CHECK (page_limit BETWEEN 1 AND 50),
  result_digest character(64) NOT NULL CHECK (result_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (statement_id, cursor_key, page_limit)
);

CREATE TABLE IF NOT EXISTS audits (
  audit_id text PRIMARY KEY,
  request_key text NOT NULL UNIQUE,
  intent_digest character(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  as_of_revision bigint NOT NULL REFERENCES authority_events(revision),
  internal_consistency boolean NOT NULL,
  wallet_count integer NOT NULL CHECK (wallet_count BETWEEN 1 AND 64),
  journal_transaction_count integer NOT NULL CHECK (journal_transaction_count BETWEEN 0 AND 512),
  journal_entry_count integer NOT NULL CHECK (journal_entry_count BETWEEN 0 AND 1024),
  balance_mismatch_count integer NOT NULL CHECK (balance_mismatch_count BETWEEN 0 AND 64),
  journal_mismatch_count integer NOT NULL CHECK (journal_mismatch_count BETWEEN 0 AND 512),
  genesis_supply bigint NOT NULL CHECK (genesis_supply BETWEEN 1 AND 10000000),
  recomputed_total bigint NOT NULL,
  version_total bigint NOT NULL,
  materialized_total bigint,
  audit_digest character(64) NOT NULL CHECK (audit_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION reject_immutable_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable authority evidence cannot be changed' USING ERRCODE = '23514';
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'lab_config', 'authority_events', 'wallet_events', 'wallet_balance_versions',
    'journal_transactions', 'journal_entries', 'statements', 'statement_items',
    'statement_page_receipts', 'audits'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_immutable', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation()',
      table_name || '_immutable', table_name
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION assert_wallet_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_id text;
  expected_count integer;
  expected_amount bigint;
  source_id text;
  destination_id text;
  actual_count integer;
  signed_total bigint;
  source_count integer;
  destination_count integer;
BEGIN
  target_id := COALESCE(NEW.journal_tx_id, OLD.journal_tx_id);
  SELECT jt.expected_entry_count, jt.amount, t.source_wallet_id, t.destination_wallet_id
    INTO expected_count, expected_amount, source_id, destination_id
  FROM journal_transactions jt
  JOIN transfer_intents t ON t.transfer_id = jt.transfer_id
  WHERE jt.journal_tx_id = target_id;

  IF expected_count IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT count(*), COALESCE(sum(delta), 0),
         count(*) FILTER (WHERE wallet_id = source_id AND side = 'debit' AND amount = expected_amount),
         count(*) FILTER (WHERE wallet_id = destination_id AND side = 'credit' AND amount = expected_amount)
    INTO actual_count, signed_total, source_count, destination_count
  FROM journal_entries
  WHERE journal_tx_id = target_id;

  IF actual_count <> expected_count OR signed_total <> 0 OR source_count <> 1 OR destination_count <> 1 THEN
    RAISE EXCEPTION 'wallet journal transaction % is not balanced', target_id USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS wallet_journal_balance_from_header ON journal_transactions;
CREATE CONSTRAINT TRIGGER wallet_journal_balance_from_header
AFTER INSERT ON journal_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_wallet_journal_balanced();

DROP TRIGGER IF EXISTS wallet_journal_balance_from_entry ON journal_entries;
CREATE CONSTRAINT TRIGGER wallet_journal_balance_from_entry
AFTER INSERT ON journal_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_wallet_journal_balanced();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transfer_journal_fk') THEN
    ALTER TABLE transfer_intents
      ADD CONSTRAINT transfer_journal_fk FOREIGN KEY (journal_tx_id) REFERENCES journal_transactions(journal_tx_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
