# DG App build plan (draft v1, 2026-10-23, DG Dev)
Goal: call.com/Numero-style app. Sign up anywhere, buy a dedicated DID in-app, call/receive (SMS phase 2).

## Key finding
SIPNAV is a wholesale switch: IP-authenticated endpoints, portal-only, no documented API, no per-user SIP registration.
So the app needs its own SIP/WebRTC layer in front of SIPNAV, and its own per-user billing.

## Architecture
User app (WebRTC over WSS) -> DG App edge server (Kamailio + rtpengine, or Asterisk PJSIP WebRTC) -> SIPNAV new account "DG App" (one endpoint + tech prefix) -> carriers.
Inbound: SIPNAV DID (carrier) -> SIPNAV "DG App" account -> edge looks up DID owner -> rings user's devices (push wake-up).

## Stack
- Mobile: React Native (iOS + Android), react-native-webrtc + SIP.js/JsSIP, CallKit + PushKit VoIP push (iOS), FCM high-priority + ConnectionService (Android).
- Web: React (same SIP.js client).
- Backend: Node.js/TypeScript API, Postgres, Redis. Stripe for payments.
- Hosting: Hetzner (same network as dialer6/closer), domain app./sip.dialergiants.com with TLS.

## DIDs (UPDATED 05:50 PKT - Umar: everything through our SIPNAV switch, no outside DID supplier)
Pool model: a block of DIDs from SIPNAV inventory is assigned once to the "DG App" SIPNAV account, routed to the app server endpoint.
The app sells from that pool in its own DB (owner, renewal); a sale or release needs no SIPNAV change. Pool is topped up on SIPNAV when it runs low.
Number countries/areas = whatever our SIPNAV carriers supply. Users can sign up from anywhere.

## Outbound + billing
Edge authenticates user, checks balance + destination allow-list, sends to SIPNAV with app tech prefix, sets CID = user's DID.
Our own retail rate deck (SIPNAV cost + markup), per-call pre-auth (max duration from balance), rated from edge CDRs, debited in Postgres. SIPNAV bills DG wholesale.
PREPAID ONLY (approved by Umar 05:54 PKT): no postpaid or credit lines. Calls blocked at zero balance; per-call pre-auth caps max duration to available balance.
Fraud controls: high-risk destination block (IRSF), velocity + concurrency limits, caps on new accounts.

## Payments
Number subscription (monthly) + credit top-ups. Web: Stripe. iOS/Android: Apple/Google in-app purchase likely required for in-app credits/subscriptions (15-30% fee) - decide pricing accordingly.

## Sign-up / KYC (APPROVED by Umar 05:54 PKT - mandatory)
KYC must pass BEFORE a user can buy a DID or place any call. Minimum: email OTP + phone OTP + verified payment method.
ID + address verification added wherever the DID country requires it. Goal: keep fraud and robocallers off the SIPNAV switch.

## Phases
1. Edge server + SIPNAV app account + web client: call out, buy a US DID, receive calls, Stripe billing.
2. Mobile apps with push incoming calls, store submission.
3. SMS, more countries, porting.

## Needed from Umar
Approval for a new SIPNAV "DG App" account/endpoint and the first DID pool (launch countries + count); a server (Hetzner) + DNS; Stripe account (keys via secure file); Apple Developer + Google Play accounts; Firebase project; launch countries, retail pricing, SMS yes/no; company details for store listings.
