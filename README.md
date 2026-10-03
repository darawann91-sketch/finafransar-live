# Finafransar LIVE

Mobile-first live shopping för **finafransar.com**. Kunden tittar, gillar, chattar och lägger produkter i den **riktiga Shopify-varukorgen** utan att lämna liven. Checkout och betalning sker i **Shopify Checkout**. Hosten sänder direkt från mobilens eller datorns webbläsare via **Live Studio**.

Butiken påverkas inte: temat, produkterna, produkt-URL:erna, navigationen, SEO och checkout ändras inte. Systemet lägger bara till en app, en App Proxy och några URL-omdirigeringar.

---

## Arkitektur

```
FINAFRANSAR SHOPIFY (källan)               FINAFRANSAR LIVE (den här servern)
 ├─ Produkter / varianter / lager  ◀────── Admin API (läser, kopierar inget)
 ├─ Varukorg (/cart/*.js)          ◀────── tittarsidan (samma domän via App Proxy)
 ├─ Checkout                       ◀────── "Till kassan" → /checkout
 ├─ Kundkonton (nya kundkonton)    ◀────── login → return_to samma live
 ├─ Rabattkoder                    ◀────── live-deal skapar riktig kod med slut-tid
 └─ Orders (webhook)               ──────▶ köp räknas per live

www.finafransar.com/live/abc123 ─(URL-omdirigering)─▶ /apps/live/abc123 ─(App Proxy)─▶ live.finafransar.com/proxy/abc123

 live.finafransar.com
 ├─ /admin          Live Studio (host/admin-login, egna konton, inte Shopify-admin)
 ├─ /ws             Realtid: chatt, likes, tittare, aktiv produkt, deal, moderering
 ├─ /api/…          Studio-API (session + CSRF), stream-biljetter
 └─ streaming-adapter ──▶ LiveKit Cloud / egen LiveKit (WebRTC, under 1 s fördröjning)
```

| Del | Lösning |
|---|---|
| Video | WebRTC via **LiveKit** (Cloud eller egen server). Simulcast 1080p/720p/360p, så varje tittare får den bästa kvalitet hennes uppkoppling klarar. |
| Byte av streamingleverantör | `src/streaming/` (server) + `public/stream/` (klient). En ny leverantör = en adapter per sida. Inget annat påverkas. `devmesh` finns bara för utveckling och tester. |
| Varukorg | Shopify Ajax Cart API på samma domän (`/cart/add.js`), dvs. **samma varukorg** som i Dawn-temat. Raden märks med `_live`, varukorgen med `_finafransar_live`. |
| Kundkonto | Shopifys nya kundkonton. `logged_in_customer_id` kommer **signerat** från App Proxy. Inga egna kundkonton finns. |
| 10 s preview | Tvingas av **servern**: gästbiljetten kopplas bort efter 10 s, nya biljetter nekas och antalet previews är begränsat per IP. |
| Live-deal | Riktig Shopify-rabattkod (`discountCodeBasicCreate`) med `endsAt`. Nedräkningen synkas mot serverns klocka. |
| Databas | SQLite (inbyggd i Node 22) på en persistent volym. Den sparar bara live-data. Produkter lagras **inte**, de hämtas från Shopify. |
| Statistik | Tittare, peak, unika, snittid, likes, kommentarer, delningar, produktvisningar, lägg i varukorg, till kassan, **köp + omsättning** (via order-webhook), nya konton, inloggningar, besök från delade länkar, preview start/klar. |

### Säkerhet
- Host-lösenord hashas med scrypt. Sessions-cookien är `__Host-`, HttpOnly, Secure och SameSite=Strict, och bara hashen av sessionen sparas.
- **CSRF-token** krävs på alla ändringar. Origin kontrolleras. Rate limiting gäller inloggning (IP och e-post), chatt (1 meddelande/2 s), likes, events och websocket-anslutningar.
- Rollkontroll sker **på servern** för varje anrop: en host kan bara styra sina egna lives, och bara admin hanterar hosts och blockeringar. Tittare kan inte skicka host-kommandon. Websocketen ignorerar dem, och testet verifierar det.
- App Proxy-signaturen (HMAC) och tidsstämpeln kontrolleras. Webhooks verifieras med HMAC.
- Chatten saneras på servern och renderas bara som text i klienten, så XSS är testat och blockerat. CSP finns på alla sidor.
- Hemligheter (Shopify, LiveKit) finns bara på servern. Inget når webbläsaren.

---

## Det här måste du göra (engångsuppsättning, ca 1–2 timmar)

### 1. LiveKit
1. Skapa ett konto på livekit.io och ett projekt. Välj plan **Ship** (eller **Scale** för fler än 1 000 samtidiga tittare).
2. Kopiera **WebSocket URL** (`wss://….livekit.cloud`), **API Key** och **API Secret**.

### 2. Hosting (exempel: Fly.io, region Stockholm)
1. Installera `flyctl` och kör `fly launch --no-deploy` i den här mappen (filen `fly.toml` finns redan).
2. `fly volumes create live_data --region arn --size 1`
3. Sätt hemligheterna:
   ```
   fly secrets set APP_SECRET="$(openssl rand -base64 48)" \
     SHOPIFY_CLIENT_ID=… SHOPIFY_CLIENT_SECRET=… \
     LIVEKIT_URL=wss://….livekit.cloud LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… \
     ADMIN_EMAIL=lela@… ADMIN_PASSWORD='minst-12-tecken'
   ```
4. `fly deploy`
5. Peka **live.finafransar.com** till appen (`fly certs add live.finafransar.com` + en CNAME hos din DNS-leverantör).

Railway och Render fungerar också med `Dockerfile`. Det viktiga är **en** instans och en persistent disk monterad på `/data`.

### 3. Shopify-appen (Dev Dashboard)
1. Gå till **dev.shopify.com → Apps → Create app** och döp den till "Finafransar LIVE".
2. Under **Versions → Create version**:
   - App URL: `https://live.finafransar.com/admin`, Embedded: **nej**
   - Scopes: `read_products, read_customers, read_discounts, write_discounts, read_online_store_navigation, write_online_store_navigation, read_orders, write_app_proxy`
   - **App proxy:** prefix `apps`, subpath `live`, URL `https://live.finafransar.com/proxy`
   - (Samma värden finns i `shopify.app.toml` om du hellre kör `shopify app deploy`.)
3. Under **API access → Protected customer data:** begär Level 1 (namn) för syftet "Visa kundens förnamn i livechatten och räkna köp per live".
4. Släpp versionen och **installera appen i finafransar.com**.
5. Kopiera **Client ID** och **Client secret** till hemligheterna ovan och kör `fly deploy` igen.

Vid start skapar servern automatiskt:
- omdirigeringen `/live` → `/apps/live` (aktuell live)
- omdirigeringen `/live/admin` → `https://live.finafransar.com/admin` (Studio)
- en omdirigering `/live/<ID>` för varje live som startas (delningslänken)
- en webhook `orders/create` som räknar köp per live

### 4. Första live
1. Öppna **finafransar.com/live/admin** och logga in med ADMIN_EMAIL/ADMIN_PASSWORD.
2. Skapa en live → **Produkter**: sök och välj → **Aktivera kamera** → **STARTA LIVE**.
3. Tryck **VISA NU** på produkten du visar. Den dyker upp hos alla tittare direkt.
4. Starta en **Deal** när du vill sälja mer, till exempel 20 % i 15 minuter.
5. Dela länken från Studio (`finafransar.com/live/<ID>`).
6. Lägg gärna en länk till `finafransar.com/live` i menyn eller i en banner. Det ändrar jag inte åt dig.

**Testa själv innan första riktiga live:** starta en live, öppna länken på din telefon i inkognito (då är du gäst), se att den låses efter 10 s, skapa konto, gör ett testköp (t.ex. med en 100 %-rabattkod) och kontrollera att köpet syns i **Statistik**.

---

## Utveckling och tester

```
npm install          # kopierar även LiveKit-klienten till public/vendor
./dev/run-dev.sh     # live-server + simulerad butik (App Proxy, varukorg, login, checkout)
#  Studio:  http://localhost:8080/admin   (admin@finafransar.test / utveckling-losen-123)
#  Tittare: http://localhost:3001/live
npm test             # enhetstester (signaturer, JWT, lösenord, sanering, produktdata)
npm run test:e2e     # hela kundresan i riktiga webbläsare (fejkkamera + WebRTC)
```

E2E-testet går igenom: host-login (och fel lösenord), CSRF/obehörig åtkomst, produktsök, kamera → live, tittare via login, video, tittarräknare, likes i realtid, chatt, rate limit, XSS, fäst kommentar, produktbyte i realtid, variantval → Shopify-varukorg, shoppa alla produkter, live-deal med nedräkning, rabatt + checkout med live-märkning, delad länk → 10 s preview → overlay → servern nekar ny ström → skapa konto → **tillbaka till samma live med samma produkt öppen** → chatta/köp, rapportering och blockering, iPhone SE / iPhone 15 Pro Max / Android / iPad / desktop, Studio på mobil, statistik och avsluta live.

---

## Kostnad och skalning

- **LiveKit Ship** 50 $/mån: 150 000 WebRTC-minuter och 250 GB ingår, max 1 000 samtidiga. Därefter 0,0005 $/min och 0,12 $/GB.
- 1080p ger ungefär 1,35 GB per tittare och timme. Större publik betyder främst mer bandbredd.
- **Fler än 1 000 samtidiga tittare:** LiveKit Scale, eller egen LiveKit-server (fast månadskostnad). Koden ändras inte, bara `LIVEKIT_URL`/nycklar.
- Live-servern (chatt/likes) klarar flera tusen samtidiga anslutningar på en instans. För flera instanser: flytta rate limits och pub/sub till Redis och databasen till Postgres (lagret är isolerat i `src/db.js` och `src/realtime/hub.js`).

## Kända begränsningar

1. Shopify kan inte visa en sida direkt på `/live`. `/live/<ID>` omdirigeras, och adressfältet visar sedan `/apps/live/<ID>`.
2. Nya kundkonton loggar in med e-postkod. "Skapa konto" och "Logga in" är därför samma flöde.
3. iPhone startar videon utan ljud tills kunden trycker **"Tryck för ljud"** (Apples regel).
4. Sänder hosten från iPhone och låser skärmen pausar iOS kameran. Studio håller skärmen vaken (Wake Lock), men stäng inte appen och använd stativ.
5. Rabatter: live-koden kombineras inte med andra produkt- och orderrabatter (bara fri frakt). Ändra `combinesWith` i `src/shopify/admin.js` om du vill annat.
6. Hosts loggar in med lösenord. Tvåfaktorsinloggning finns inte ännu.
