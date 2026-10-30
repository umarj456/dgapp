import { config } from '../../config.js';
import type { Db } from '../../db.js';
import { randomToken, sipHa1 } from '../../lib/crypto.js';

/**
 * Issues a per-device SIP credential. The password is returned ONCE to the client; only HA1 is stored,
 * which is what Kamailio needs for digest auth (pv_auth_check with HA1 flag).
 */
export async function issueDeviceCredential(db: Db, userId: string, aor: string, deviceLabel: string) {
  const username = `${aor}-${randomToken(4).replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 6) || 'd'}`;
  const password = randomToken(18);
  await db.query(
    `INSERT INTO sip_credentials (user_id, auth_username, ha1, device_label) VALUES ($1,$2,$3,$4)`,
    [userId, username, sipHa1(username, config.SIP_REALM, password), deviceLabel],
  );
  return { authUsername: username, password, aor, realm: config.SIP_REALM };
}

export async function lookupHa1(db: Db, authUsername: string) {
  const r = await db.query(
    `SELECT s.ha1, u.sip_aor, u.status FROM sip_credentials s JOIN users u ON u.id=s.user_id
      WHERE s.auth_username=$1 AND s.revoked_at IS NULL`,
    [authUsername],
  );
  if (!r.rowCount || r.rows[0].status !== 'active') return null;
  return { ha1: r.rows[0].ha1 as string, aor: r.rows[0].sip_aor as string };
}

export async function revokeDeviceCredential(db: Db, userId: string, authUsername: string) {
  await db.query(`UPDATE sip_credentials SET revoked_at=now() WHERE user_id=$1 AND auth_username=$2`, [userId, authUsername]);
}
