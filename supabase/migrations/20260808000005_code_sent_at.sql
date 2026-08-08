-- Tracks whether the code currently in a row has ever been emailed out.
--
-- Plaintext codes are never stored -- only a per-row salt and hash -- so the
-- server cannot re-send a code it handed out earlier. That makes "who still
-- needs their code" impossible to answer after the fact unless it is recorded
-- as it happens, which is what this column does.
--
-- NULL means the code in this row has not been sent. Every path that mints a
-- code resets it to NULL, so the flag can never outlive the code it describes.
alter table public.participants
  add column code_sent_at timestamptz;

comment on column public.participants.code_sent_at is
  'When the code currently in this row was emailed to the participant. NULL means it never was; minting a new code always clears it.';
