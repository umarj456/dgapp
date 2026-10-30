# DG App edge (Kamailio + rtpengine)

Configs are ready for a lab install. Nothing in this folder has been installed. No SSH, SIPNAV change, or firewall change has been made from this repo.

Install steps, the ports that stay off Asterisk and the DID portal, and who does what after merge: [`EDGE_DEPLOY.md`](../EDGE_DEPLOY.md).

`kamailio.cfg` was syntax-checked on Kamailio 6.0.1 before the lab port split. Developer runs `kamailio -c` on the host before start. The substdef that puts the API token into the JSON header was checked the same way.

## What it does
```
App (SIP.js)  --WSS:18443, DTLS-SRTP-->  Kamailio + rtpengine  --UDP 15060-->  SIPNAV 88.151.129.15:5060
SIPNAV DID    --UDP 15060-->             Kamailio + rtpengine  --WSS:18443-->  registered devices of the owner
```
UDP 5060 on 138 stays with Asterisk. TCP 8443 stays with dialer-monitor. TCP 8080 stays with the DID portal.
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
- `kamailio/kamailio.cfg`: routing. Per-host values come from `dg-local.cfg`.
- `kamailio/dg-local.cfg.example`: lab values for 138, including SIPNAV `88.151.129.15` and API `http://127.0.0.1:4100`.
- `kamailio/tls.cfg`: self-signed cert under `/opt/dgapp-edge/certs`. A DNS name is optional.
- `rtpengine/rtpengine.conf`: userspace media relay, UDP 35000-35999.
- `firewall.nft.example`: dedicated-VM sketch. Do not load it on 138. That host already runs firewalld.

## Deployment
Follow [`EDGE_DEPLOY.md`](../EDGE_DEPLOY.md) only after Umar says go. Developer installs on 138 under `/opt/dgapp-edge` and `/etc/kamailio`. LEAD confirms the SIPNAV account id, the signalling IP (default `88.151.129.15`), the tech prefix (placeholder `"05436#"` until then), and the DIDs that route to UDP `15060`.

Lab test before real traffic (with LEAD's test DIDs):
   - register two browsers, check `kamcmd ul.dump`;
   - outbound to a test number: correct caller ID, prefix seen on SIPNAV, audio both ways, hard stop at max duration with a tiny balance;
   - KYC-incomplete user, zero balance, blocked prefix, second concurrent call on a new account: all refused;
   - inbound DID rings all devices of the owner; unassigned DID gets 404;
   - CDR in `cdrs`, wallet charged per rate deck increment.

Go live only after that lab test: point the real DID pool at UDP 15060 and open sign-ups.

## Known gaps / to verify in the lab
- rtpengine flag sets for each direction (offer vs answer, DTLS role) are the standard WebRTC <-> RTP pattern but need a real call test.
- `http_client_query` is synchronous. Fine for Phase 1 volume; switch to `http_async_client` if latency becomes an issue.
- usrloc is in memory (registrations lost on restart; clients re-register within 5 min). Use DB/Redis for HA later.
- Mobile push wake-up (PushKit/FCM via `tsilo` + `t_suspend`) is Phase 2; Phase 1 returns 480 when no device is registered.
- SMS is not in scope for Phase 1.

## What Umar and LEAD must confirm
- Go-ahead before Developer installs on 138. DNS for `sip.dialergiants.com` stays optional for this lab.
- SIPNAV DG App account id, signalling IP (default `88.151.129.15`), tech prefix (placeholder `"05436#"`), and attestation.
- The first real DID pool, routed to `138.201.138.161` UDP `15060`.
- A SIPNAV-side allow for this host's IP, if their switch requires one.
