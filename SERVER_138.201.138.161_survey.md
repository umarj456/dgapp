# Server 138.201.138.161 – read-only survey (2026-10-23 06:49 PKT)
LIVE production "web server for apps environment". Login root via SSH (creds in dev/secure/appweb.env, helper dev/secure/appweb_ssh.sh). Server clock is CEST.

## System
- AlmaLinux 9.7, kernel 5.14.0-570, uptime 339 days, hostname Alma-9-latest-amd64-base
- 8 vCPU Xeon E3-1275 v6, RAM 62 GiB (48 GiB available), swap 31 GiB unused
- Disk: / (md2 RAID, ext4) 407G, 349G free; /boot 989M. /opt and /var/www are on / (no separate mounts)
- SELinux Permissive; firewalld active; fail2ban active; no config management (no puppet/salt/chef/ansible agent); no cPanel/Plesk

## Public listeners (firewalld public zone: ssh, http, https, cockpit, 8080, 4001, 8443; rich rules for 115.186.137.93 -> 22, 4000, 5432)
- 22 sshd; 80/443/8080 nginx 1.20.1 (8080 = DID lookup portal /var/www/did-portal)
- 3306 MariaDB 10.5 main (bound *), 4000 HuzaifaHelp node, 4001 lead-intake-api node, 4010 dg-inbox node (all bound *)
- 8443 dialer-monitor python (accept queue 129/128 – looks saturated)
- UDP 5060/4520 Asterisk

## Loopback-only listeners
4002 PM2, 4023 + 7777 Next.js, 3307 MariaDB scrubber, 3308 MariaDB vicidial, 5432 PostgreSQL 13.22, 6379 Redis, 8090 nginx, 8711 Kokoro TTS, 8765 dialer-monitor, 11434 Ollama, 44935/38375 llama-server, 5038 Asterisk AMI

## Running services (notable)
nginx, php-fpm (+ php-fpm-scrubber, php-fpm-vicidial), mariadb (+ -scrubber, -vicidial), postgresql 13, redis, asterisk, ollama, aibot-kokoro, dialer-monitor, vd-operator, scrubber-scheduler/workers, fail2ban, firewalld, crond.
httpd 2.4.62 installed but NOT running (nginx owns :80).
PM2 (root): huzaifahelp-api, lead-intake-api, dialer-giants-kyc, dg-inbox, avensa-crm-v3.

## nginx vhosts (/etc/nginx/conf.d)
crm.avensaltd.com, did-portal, huzaifahelp, inbox.dialergiants.com, jornaya.*, kyc.dialergiants.com, lead-admin, monitor (monitor.dialergiants.com), scrubber, send_to_gsheet, vd-operator, vicidial-aibot, default 138.201.138.161. Several .bak files alongside.

## Runtimes
- Node v20.19.5 / npm 10.8.2 (system, dnf module nodejs:20); PM2 6.0.13
- PostgreSQL 13.22 server running (loopback 5432); repo offers postgresql 15/16/18 modules
- PHP 8.2.30, Python 3.9.25, MariaDB 10.5.29
- Docker/Podman: NOT installed

## Users / dirs
- Only root has a login shell among human users; /home empty. Service users: nginx, apache, postgres, mysql, dialermon, scrubber, aibot, asterisk, ollama, redis. wheel group empty, /etc/sudoers.d empty.
- /opt: aibot (767M), dialer-monitor (45M)  [+ new dgapp-test]
- /var/www: avensa-crm (+ release, v2, v3, pre-timetracking backup), dg-inbox (+3 backups), dialer-giants-kyc, did-portal, html (7.6G), lead-admin, lead-api, lead-intake-api, scrubber, jornaya, *-acme cert dirs, misc DNS/SSL notes
- /etc/cron.d: 0hourly, lead-admin-schedule, monitor-cert-renew, scrubber-backup, scrubber-cert-renew; no root crontab

## Free ports checked (unused): 3000, 3100, 4100, 4200, 5100, 5433, 18080

## Added by DG Dev (only change)
- system user/group dgapptest (uid/gid 986, password locked, no sudo, home /opt/dgapp-test, /bin/bash)
- /opt/dgapp-test (750, dgapptest) with app/ (128 files, no node_modules/.env/secrets; .env.example placeholders only) and README-TEST.txt
- Removal: `userdel -r dgapptest`

## Recommendations to actually run it (NOT done – need Umar's OK)
1. Ports: API on 127.0.0.1:4100, web preview on 127.0.0.1:4200 (both free). Never 8080 (live DID portal) or 5432. Loopback only, no firewall change; view via SSH tunnel.
2. Node: system Node 20 is fine. `npm ci` as dgapptest inside /opt/dgapp-test/app (user-local, no system packages). Run with plain `node` / a user-level PM2 under dgapptest – not root's PM2.
3. Postgres: existing PG 13 is live. Option A (least invasive): run a separate user-owned PG cluster with `initdb` as dgapptest in /opt/dgapp-test/pgdata on 127.0.0.1:5433 – no change to the live cluster, but needs check that app SQL works on PG13 (compose uses PG16). Option B: add a dgapp role+DB to the live cluster (touches live PG + pg_hba – not recommended).
4. Docker: not installed; installing it would add iptables/nftables rules alongside firewalld and could affect live networking – do not install on this box.
5. Edge (Kamailio/rtpengine) cannot run here: Asterisk already holds UDP 5060 and it would need public ports – needs its own server.
