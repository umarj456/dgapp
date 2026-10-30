# DG App edge (Kamailio + rtpengine): DRAFT, NOT DEPLOYED

Nothing in this folder has been installed or applied anywhere. No server, SIPNAV account or DID has been touched.
`kamailio.cfg` passes `kamailio -c` syntax check on Kamailio 6.0.1 (run on our own shared computer with placeholder values only).
The substdef/define substitution used for the API token header was verified on the same box.

## What it does
```
App (SIP.js / react-native-webrtc)  --WSS:8443, DTLS-SRTP-->  Kamailio + rtpengine  --UDP 5060, RTP-->  SIPNAV "DG App" account
SIPNAV DID (inbound)               --UDP 5060, RTP-------->  Kamailio + rtpengine  --WSS, SRTP----->  every registered device of the owner
```
| Step | Kamailio route | API call |
|---|---|---|
| REGISTER / INVITE digest auth (per-device credential, HA1 only) | `route[AUTH]` | `GET /internal/v1/sip/auth` |
| Outbound authorize: KYC gate, fraud (IRSF blocklist, velocity, concurrency, new-account caps), prepaid pre-auth | `route[FROM_APP]` | `POST /internal/v1/calls/authorize` |
| Hard stop at pre-authorized max duration (prepaid) | `dlg_set_timeout` + `send_bye` | - |
| Outbound to SIPNAV: R-URI `<tech prefix><E.164>@SIPNAV`, From/PAI = user's DID, client identity headers stripped | `route[FROM_APP]` | - |
| Inbound DID from SIPNAV (source IP checked) -> owner AoR -> fork to all devices | `route[FROM_SIPNAV]` | `POST /internal/v1/calls/inbound` |
| Hangup: settle hold + CDR. Unanswered/failed: billsec 0 releases the hold | `event_route[dialog:end]`, `failure_route` | `POST /internal/v1/calls/end` |
| WebRTC <-> RTP media (ICE, DTLS-SRTP, rtcp-mux <-> plain RTP/AVP) | `route[NATMANAGE]`, `onreply_route[REPLY]` | - |
| Flood/scanner protection | `pike`, `htable ipban`, UA filter, WSS Origin check | - |

Files:
- `kamailio/kamailio.cfg`: main config (placeholders in UPPERCASE substdefs).
- `kamailio/dg-local.cfg.example`: per-server values, copied to `/etc/kamailio/dg-local.cfg` (never in git).
- `kamailio/tls.cfg`: WSS certificate (Let's Encrypt for `sip.dialergiants.com`).
- `rtpengine/rtpengine.conf`: media relay.
- `firewall.nft.example`: SIP only from SIPNAV, WSS + RTP open.

## Deployment steps (only after Umar approves each item below)
1. **Server**: new Hetzner VM (e.g. CPX31, Debian 12/13) in the same DC as dialer6/closer, public IPv4. The API + Postgres can share it in Phase 1, or run on a second small VM on the private network.
2. **DNS**: `sip.dialergiants.com` -> edge IP, `app.dialergiants.com` -> web/API. `certbot certonly --standalone -d sip.dialergiants.com` with a deploy hook that runs `kamcmd tls.reload`.
3. **Packages**: Kamailio 6.0 from deb.kamailio.org (`kamailio kamailio-websocket-modules kamailio-tls-modules kamailio-json-modules kamailio-utils-modules kamailio-extra-modules`), rtpengine (`rtpengine-daemon` from the Sipwise/dfx repo, kernel module optional).
4. **SIPNAV (needs Umar's approval, done by Umar or DG LEAD)**: create a new "DG App" customer account with one IP-authenticated endpoint = edge public IP, its own tech prefix (placeholder `05436#`), carriers + attestation like the other accounts, and the retail-facing rate deck. Assign the first DID pool to this account, routed to the edge IP.
5. **Config**: copy `dg-local.cfg.example` -> `/etc/kamailio/dg-local.cfg`, fill IPs, SIPNAV signalling IP, tech prefix (API side `.env` `SIPNAV_TECH_PREFIX`), and `API_TOKEN` (= API `INTERNAL_API_TOKEN`, from a secure file, not chat). Set rtpengine `interface` to private!public IPs.
6. **Firewall**: apply `firewall.nft.example` (SIP/UDP 5060 only from SIPNAV IP; 8443 + RTP 30000-40000 open; SSH from admin IPs). API port 8080 only on the private network; the API also checks `INTERNAL_ALLOWED_IPS` + bearer token for `/internal/*`.
7. **Lab test before real traffic** (with Umar's test DIDs):
   - register two browsers, check `kamcmd ul.dump`;
   - outbound to a test number: correct caller ID, prefix seen on SIPNAV, audio both ways, hard stop at max duration with a tiny balance;
   - KYC-incomplete user, zero balance, blocked prefix, second concurrent call on a new account: all refused;
   - inbound DID rings all devices of the owner; unassigned DID gets 404;
   - CDR in `cdrs`, wallet charged per rate deck increment.
8. **Go live**: point the DID pool at the edge, open sign-ups.

## Known gaps / to verify in the lab
- rtpengine flag sets for each direction (offer vs answer, DTLS role) are the standard WebRTC <-> RTP pattern but need a real call test.
- `http_client_query` is synchronous. Fine for Phase 1 volume; switch to `http_async_client` if latency becomes an issue.
- usrloc is in memory (registrations lost on restart; clients re-register within 5 min). Use DB/Redis for HA later.
- Mobile push wake-up (PushKit/FCM via `tsilo` + `t_suspend`) is Phase 2; Phase 1 returns 480 when no device is registered.
- SMS is not in scope for Phase 1.

## What Umar must approve
- The edge server (Hetzner size/cost) and DNS records.
- Creating the SIPNAV "DG App" account, endpoint IP, tech prefix and attestation level.
- The first DID pool (countries, count) assigned to that account.
- Firewall rule on SIPNAV side, if SIPNAV needs the edge IP whitelisted.
