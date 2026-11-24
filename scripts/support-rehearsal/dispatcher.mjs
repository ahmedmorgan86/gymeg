// Candidate extraction from supplied v4 prototype. No production entrypoint.
// Dependency-injected DB/transport only. No FCM credential or app import.
// At least once: in-flight lease reclaim and send-before-mark can duplicate.
// Claims snapshot once, on first claim, not again on retry/reclaim.
export async function claim(db, worker, limit) {
  await db.query('BEGIN');
  try {
  const { rows } = await db.query(
    `WITH c AS (SELECT event_id FROM gymos.support_alert_outbox
       WHERE (status='pending' AND next_retry_at <= now())
          OR (status='sending' AND claimed_at < now() - interval '2 minutes')
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1)
     UPDATE gymos.support_alert_outbox o SET status='sending', claimed_by=$2, claimed_at=now(), claim_seq=o.claim_seq+1
     FROM c WHERE o.event_id=c.event_id RETURNING o.event_id, o.claim_seq`, [limit, worker]);
  const deliverable = [];
  for (const r of rows) {
    const snap = r.claim_seq === 1 ? await db.query(
      `INSERT INTO gymos.support_alert_recipients(event_id, user_id, token_hash)
       SELECT $1, s.user_id, s.token_hash FROM gymos.support_fcm_subscriptions s
       JOIN gymos.platform_admins a ON a.user_id = s.user_id ON CONFLICT DO NOTHING`, [r.event_id]) : {rowCount: 0};
    if (snap.rowCount === 0 && r.claim_seq === 1) {
      await db.query(`UPDATE gymos.support_alert_outbox SET status='no_recipients' WHERE event_id=$1`, [r.event_id]);
    } else deliverable.push(r);
  }
  await db.query('COMMIT');
  return deliverable;
  } catch(error) {
    try { await db.query('ROLLBACK'); } catch { /* caller must dispose failed client */ }
    throw error;
  }
}

const stillMine = (db, id, seq, worker) =>
  db.query(`SELECT 1 FROM gymos.support_alert_outbox WHERE event_id=$1 AND claim_seq=$2 AND claimed_by=$3 AND status='sending'`, [id, seq, worker])
    .then(r => r.rowCount === 1);

async function guardedRecipientUpdate(db, id, tokenHash, seq, worker, status) {
  const r = await db.query(
    `UPDATE gymos.support_alert_recipients r SET status=$3 FROM gymos.support_alert_outbox o
      WHERE r.event_id=$1 AND r.token_hash=$2 AND o.event_id=r.event_id AND o.claim_seq=$4 AND o.claimed_by=$5`,
    [id, tokenHash, status, seq, worker]);
  return r.rowCount === 1;
}

export async function deliverClaimed(db, worker, claims, sendFcm, calls, crashBeforeMark) {
  let sent = 0, dropped = 0, failed = 0, undeliverable = 0, fencedOut = false;
  for (const { event_id: id, claim_seq: seq } of claims) {
    await db.query(
      `UPDATE gymos.support_alert_recipients r SET status='gone' FROM gymos.support_alert_outbox o
        WHERE r.event_id=$1 AND r.status='pending'
          AND NOT EXISTS (SELECT 1 FROM gymos.support_fcm_subscriptions s WHERE s.user_id=r.user_id AND s.token_hash=r.token_hash)
          AND o.event_id=r.event_id AND o.claim_seq=$2 AND o.claimed_by=$3`, [id, seq, worker]);
    const { rows: recips } = await db.query(
      `SELECT r.user_id, r.token_hash, s.token_ciphertext,
              EXISTS(SELECT 1 FROM gymos.platform_admins a WHERE a.user_id=r.user_id) AS eligible
         FROM gymos.support_alert_recipients r
         JOIN gymos.support_fcm_subscriptions s ON s.user_id=r.user_id AND s.token_hash=r.token_hash
        WHERE r.event_id=$1 AND r.status='pending'`, [id]);
    for (const r of recips) {
      if (!r.eligible) { await guardedRecipientUpdate(db, id, r.token_hash, seq, worker, 'ineligible'); continue; }
      if (!(await stillMine(db, id, seq, worker))) { fencedOut = true; break; } // PRE-SEND FENCE
      calls.push(id + '|' + r.token_hash);
      let res;
      try { res = await sendFcm(r.token_ciphertext); } catch { res = 'fail'; }
      if (crashBeforeMark && crashBeforeMark === r.token_hash && res === 'ok') return { crashed: true, sent, dropped, failed, undeliverable };
      if (res === 'ok') { if (await guardedRecipientUpdate(db, id, r.token_hash, seq, worker, 'sent')) sent++; else { fencedOut = true; break; } }
      else if (res === 'decrypt-error') { if (await guardedRecipientUpdate(db, id, r.token_hash, seq, worker, 'undeliverable')) undeliverable++; else { fencedOut = true; break; } }
      else if (res === 'unregistered') {
        await db.query(`DELETE FROM gymos.support_fcm_subscriptions WHERE user_id=$1 AND token_hash=$2`, [r.user_id, r.token_hash]);
        if (await guardedRecipientUpdate(db, id, r.token_hash, seq, worker, 'dropped')) dropped++; else { fencedOut = true; break; }
      } else failed++;
    }
    if (fencedOut) continue;
    await db.query('BEGIN');
    try {
    const st = await db.query(`SELECT
        count(*) FILTER (WHERE status='pending')::int AS pending,
        count(*) FILTER (WHERE status='sent')::int AS sent_n
      FROM gymos.support_alert_recipients WHERE event_id=$1`, [id]);
    const { pending, sent_n } = st.rows[0];
    let fin;
    if (pending === 0) {
      const final = sent_n > 0 ? 'delivered' : 'delivered_none';
      fin = await db.query(`UPDATE gymos.support_alert_outbox SET status=$4, updated_at=now() WHERE event_id=$1 AND claim_seq=$2 AND claimed_by=$3 RETURNING event_id`, [id, seq, worker, final]);
    } else {
      fin = await db.query(
        `UPDATE gymos.support_alert_outbox SET attempts=attempts+1, last_error='fcm-failure', updated_at=now(),
           next_retry_at = now() + (least(power(2, attempts) * 30, 1800) || ' seconds')::interval,
           status=CASE WHEN attempts+1>=5 THEN 'failed' ELSE 'pending' END
         WHERE event_id=$1 AND claim_seq=$2 AND claimed_by=$3 RETURNING event_id`, [id, seq, worker]);
    }
    await db.query('COMMIT');
    if (fin.rowCount === 0) fencedOut = true;
    } catch(error) {
      try { await db.query('ROLLBACK'); } catch { /* caller must dispose failed client */ }
      throw error;
    }
  }
  return { events: claims.length, sent, dropped, failed, undeliverable, fencedOut };
}

