# Edge lab install on 138.201.138.161

WebRTC browser → Kamailio + rtpengine → SIPNAV. This file is the install Developer runs **after Umar says go**. Nothing here has been installed. This repo does not SSH to the host.

The path:

```
Browser (SIP.js) --WSS 18443, DTLS-SRTP--> Kamailio + rtpengine --UDP 15060--> SIPNAV 88.151.129.15:5060
SIPNAV DID       --UDP 15060-->            Kamailio + rtpengine --WSS 18443--> the owner's registered devices
```

Call control stays on the test API at `http://127.0.0.1:4100`:

| Step | Kamailio | API |
|---|---|---|
| REGISTER / INVITE digest (HA1 only) | `route[AUTH]` | `GET /internal/v1/sip/auth` |
| Outbound KYC, fraud, prepaid hold | `route[FROM_APP]` | `POST /internal/v1/calls/authorize` |
| Inbound DID to the owner's devices | `route[FROM_SIPNAV]` | `POST /internal/v1/calls/inbound` |
| Hangup, settle, CDR | `event_route[dialog:end]`, failure routes | `POST /internal/v1/calls/end` |

The tech prefix is **not** in Kamailio. `authorize` returns `ruri_user` already prefixed. Until LEAD confirms the live account, the API value is the placeholder, quotes required so the `#` is kept:

```
SIPNAV_TECH_PREFIX="05436#"
```

Developer replaces that string, and `SIPNAV_IP` in `dg-local.cfg`, when LEAD sends the real account id, prefix, and switch address. Do not commit the replacement.

## Do not touch

Survey of this host (`SERVER_138.201.138.161_survey.md`): AlmaLinux 9, firewalld, nginx, Asterisk. Leave these alone:

| Already in use | Owner |
|---|---|
| UDP 5060 and 4520 | Asterisk |
| TCP 8443 | dialer-monitor |
| TCP 80, 443, 8080 | nginx (8080 is the DID portal) |
| TCP 5432 on loopback | live Postgres |
| root PM2, `/var/www`, `/etc/nginx` | other apps |

The lab edge uses UDP **15060**, TCP **18443**, and RTP **35000-35999**. Confirm each is free with `ss` before binding. If 35000-35999 overlaps Asterisk, read `rtpstart` / `rtpend` in `/etc/asterisk/rtp.conf` and change only this edge's range. Do not edit `rtp.conf`.

`edge/firewall.nft.example` is a drop-policy sketch for a future empty VM. Loading it here can cut off SSH and the live apps. Use the firewalld rules below.

## What LEAD confirms

- SIPNAV account id for the DG App customer.
- Signalling IP. The file default is `88.151.129.15` until LEAD says otherwise.
- Exact tech prefix. The placeholder is `"05436#"`.
- That the account's endpoint is `138.201.138.161` **UDP 15060** (not 5060), and which DIDs route there.
- That SIPNAV will accept our source port 15060.

## What Developer runs after merge

1. Clone the repo to `/opt/dgapp-edge/src/dgapp` (a new directory). Do not put it inside the DID portal tree.
2. Install Kamailio 6.0 and a userspace rtpengine (below).
3. Copy configs, generate the self-signed certificate, set the API realm and WSS URL.
4. `kamailio -c` must succeed before `systemctl start`.
5. Add the three firewalld rules. Do not reload firewalld until Umar has said go.
6. Start `dgapp-rtpengine`, then `kamailio`.

### Packages (AlmaLinux 9)

This host is AlmaLinux 9, so the install is `dnf`, not `apt`.

```bash
cat > /etc/yum.repos.d/kamailio-6.0.repo <<'EOF'
[kamailio-6.0]
name=Kamailio 6.0 AlmaLinux 9
baseurl=https://rpm.kamailio.org/alma/9/6.0/6.0/x86_64/
enabled=1
gpgcheck=0
EOF
dnf install -y kamailio kamailio-websocket kamailio-tls kamailio-jansson kamailio-http_client
```

`gpgcheck=0` is only because this snippet does not pin a fingerprint. Turn it on after importing the key published with that repository. If `kamailio -c` reports a missing `.so`, install the matching `kamailio-<name>` package from the same repo (pike and htable are often already in the base package).

rtpengine stays in userspace (`table = -1` in the conf). Do not build or load the kernel module.

```bash
dnf install -y gcc make pkgconfig glib2-devel libevent-devel openssl-devel zlib-devel libpcap-devel json-glib-devel
install -d /opt/dgapp-edge/src
git clone --depth 1 --branch mr12.5.1.56 https://github.com/sipwise/rtpengine.git /opt/dgapp-edge/src/rtpengine
make -C /opt/dgapp-edge/src/rtpengine/daemon
install -m 755 /opt/dgapp-edge/src/rtpengine/daemon/rtpengine /usr/local/bin/rtpengine
```

`mr12.5.1.56` is the mr12.5 LTS tag. A newer `mr12.5.1.*` tag is fine. Still do not `make` the `kernel-module` directory.

Debian 12 is a different machine. Do not run `apt` on 138. On Debian the Kamailio 6.0 packages are `kamailio`, `kamailio-websocket-modules`, `kamailio-tls-modules`, `kamailio-json-modules`, and `kamailio-extra-modules` from `http://deb.kamailio.org/kamailio60 bookworm main`, plus a userspace `rtpengine` with the same `table = -1` conf.

### Config and certificate

```bash
install -d -m 750 /opt/dgapp-edge/certs /etc/rtpengine /opt/dgapp-edge/src
git clone https://github.com/umarj456/dgapp.git /opt/dgapp-edge/src/dgapp
cp /opt/dgapp-edge/src/dgapp/edge/kamailio/kamailio.cfg /etc/kamailio/kamailio.cfg
cp /opt/dgapp-edge/src/dgapp/edge/kamailio/dg-local.cfg.example /etc/kamailio/dg-local.cfg
cp /opt/dgapp-edge/src/dgapp/edge/kamailio/tls.cfg /etc/kamailio/tls.cfg
cp /opt/dgapp-edge/src/dgapp/edge/rtpengine/rtpengine.conf /etc/rtpengine/rtpengine.conf
chmod 640 /etc/kamailio/dg-local.cfg
chown root:kamailio /etc/kamailio/dg-local.cfg

openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
  -keyout /opt/dgapp-edge/certs/privkey.pem \
  -out /opt/dgapp-edge/certs/fullchain.pem \
  -subj "/CN=138.201.138.161" \
  -addext "subjectAltName=IP:138.201.138.161"
chown root:kamailio /opt/dgapp-edge/certs/privkey.pem
chmod 640 /opt/dgapp-edge/certs/privkey.pem
```

Adjust the `cp` source if the clone path differs. `dg-local.cfg.example` is already filled for this host: public IP `138.201.138.161`, SIPNAV `88.151.129.15`, API `http://127.0.0.1:4100`, WSS origin `http://127.0.0.1:4200`. `API_TOKEN` in that file is the placeholder `change-me-dev-only`. Set it to the same value as `INTERNAL_API_TOKEN` in `/opt/dgapp-test/app/backend/.env`. The token must not contain `!` (that character is the substdef delimiter). Do not commit `dg-local.cfg`.

No public DNS is required. Browsers reject a self-signed WSS certificate until the tester trusts `/opt/dgapp-edge/certs/fullchain.pem`. `sip.dialergiants.com` can stay unset. When that name exists, point `tls.cfg` at the Let's Encrypt files and run `kamcmd tls.reload`.

On the test API (`NODE_ENV=development`), set and restart:

```
SIP_REALM=138.201.138.161
SIP_WSS_URL=wss://138.201.138.161:18443/ws
SIPNAV_TECH_PREFIX="05436#"
```

`SIP_REALM` must equal Kamailio `SIP_DOMAIN` or digest auth fails. Sign out of the web UI afterward so the next SIP credential is hashed with the new realm. `INTERNAL_ALLOWED_IPS` stays `127.0.0.1,::1,::ffff:127.0.0.1` because Kamailio calls the API on loopback.

### Firewalld (add only)

```bash
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="88.151.129.15" port port="15060" protocol="udp" accept'
firewall-cmd --permanent --add-port=18443/tcp
firewall-cmd --permanent --add-port=35000-35999/udp
firewall-cmd --reload
```

If LEAD changes the signalling IP, change the rich rule and `SIPNAV_IP` together. Do not open UDP 5060. Do not remove existing services.

### Start

```bash
cat > /etc/systemd/system/dgapp-rtpengine.service <<'EOF'
[Unit]
Description=DG App rtpengine (userspace)
After=network.target

[Service]
ExecStart=/usr/local/bin/rtpengine --config-file=/etc/rtpengine/rtpengine.conf --foreground
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
kamailio -c -f /etc/kamailio/kamailio.cfg
systemctl enable --now dgapp-rtpengine
systemctl enable --now kamailio
```

`ss` should show `138.201.138.161:18443` TCP, `138.201.138.161:15060` UDP, and `127.0.0.1:2223` UDP. It must not show Kamailio on 5060, 8080, or 8443.

### Lab check

- Two browsers, tunnel `ssh -L 4200:127.0.0.1:4200`, UI at `http://127.0.0.1:4200`. `kamcmd ul.dump` shows both registrations.
- Outbound to a number LEAD has routed: caller ID is the user's DID, the request URI user starts with the confirmed prefix, audio both ways, and a tiny balance hard-stops the call.
- A user who has not finished KYC, a zero balance, a blocked prefix, and a second concurrent call on a new account are refused by the API.
- An inbound call to an assigned DID rings registered devices. An unassigned DID gets 404.
- `cdrs` and the wallet match the rate-deck increment.

Until those DIDs exist, signup → stub Stripe → buy number still works (`TESTING.md`) and the Dialer stops at WSS registration.
