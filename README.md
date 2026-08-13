# Label Agent

Deze Label Agent is opgezet om vanuit Make automatisch een meertalig food-label te maken op basis van een productspecificatie. De agent draait op Railway als Node.js HTTP-service en gebruikt de Teams/SharePoint-kanaalmap als centrale bron voor de sjablonen, vertalingendatabase, inputbestanden, outputbestanden en run-log.

Belangrijk uitgangspunt: SharePoint is de bron van waarheid. Er worden geen lokale templates of lokale vertalingen gebruikt in productie. Als QA een vertaling aanpast in de Excel in Teams, gebruikt de agent die aangepaste versie direct bij de volgende run.

## Korte Samenvatting Voor IT

De technische keten is als volgt:

1. Een mail komt binnen in Make via een mailhook.
2. Make stuurt de productspecificatie naar de Railway endpoint `POST /labels?async=true`.
3. Railway start een label-run en geeft direct een `runId` en `statusUrl` terug.
4. De agent haalt de actuele bestanden op uit de Teams/SharePoint-kanaalmap.
5. De agent leest sheet `2. BASIC` uit de productspecificatie.
6. De agent bepaalt automatisch welk Word-sjabloon nodig is: normaal, diepvries of diepvries visserijproduct.
7. De agent gebruikt `Labels_13_talen.xlsx` als goedgekeurde vertalingendatabase.
8. Alleen als een term of tekst niet betrouwbaar in de database staat, gebruikt de agent OpenAI als fallback/researchlaag.
9. In het Word-label wordt automatisch ingevulde en vertrouwde tekst groen gemarkeerd.
10. AI fallback met hoge zekerheid wordt paars gemarkeerd.
11. AI fallback met twijfel, fouten of manual-required output wordt rood gemarkeerd.
12. Alles buiten de vertalingendatabase blijft zichtbaar in de rapportage voor menselijke QA-controle.
13. Het gemaakte Word-label, een korte rapportage en de run-log worden opgeslagen in SharePoint.
14. Make pollt de `statusUrl` totdat de run klaar is en gebruikt daarna de SharePoint-link en rapportage in de mail.

## Architectuur

De oplossing bestaat uit vier hoofdonderdelen:

- Make: ontvangt de e-mail, stuurt de specificatie naar de agent, pollt de status en verstuurt de uiteindelijke e-mail.
- Railway: host de Node.js service die de API endpoints aanbiedt en de label-run uitvoert.
- Teams/SharePoint: bewaart alle bronbestanden en outputbestanden.
- OpenAI: wordt alleen gebruikt als fallback wanneer de eigen vertalingendatabase geen betrouwbare match heeft.

De agent gebruikt Microsoft Graph met app-only credentials om bestanden uit de Teams/SharePoint-map te downloaden en nieuwe bestanden terug te uploaden.

## Teams/SharePoint Structuur

In het Teams-kanaal `Automatisering` staat de bestandenmap. De agent gebruikt deze map via Microsoft Graph. De gewenste structuur is:

```text
Templates/
  BI09-....docx
  BI13-....docx
  BI53-....docx
Database/
  Labels_13_talen.xlsx
Input/
Output/
Run log/
  label-agent-runs.xlsx
```

De bestanden blijven normale Office-bestanden. QA kan dus de vertalingendatabase aanpassen in Excel en marketing/QA kan de Word-sjablonen aanpassen in Word. Zolang de bestandsnamen of de ingestelde SharePoint-paden gelijk blijven, hoeft de agent niet opnieuw gedeployd te worden.

## Exacte Volgorde Per Run

1. Make ontvangt een e-mail met een productspecificatie als bijlage.
2. Make doet een HTTP `POST` naar `/labels?async=true`.
3. De agent controleert de autorisatie met `MAKE_WEBHOOK_SECRET`.
4. De agent maakt een uniek `runId`, bijvoorbeeld `20260811121245-69gxbv`.
5. De API reageert direct met `status=processing`, `runId`, `pollAfterSeconds` en `statusUrl`.
6. De echte verwerking loopt daarna op de achtergrond door in Railway.
7. Als Make de specificatie multipart meestuurt, uploadt de agent deze eerst naar `Input/YYYY-MM-DD/` in SharePoint.
8. Als Make een `sharePointSpecPath` meestuurt, downloadt de agent dat bestand direct uit SharePoint.
9. De agent leest de Excel-specificatie en zoekt daarin sheet `2. BASIC`.
10. De parser haalt artikelnummer, naam, herkomst, ingredienten, allergenen, voedingswaarden, gewicht, opslagteksten, EAN en eventuele visserijgegevens uit de spec.
11. De parser bepaalt op basis van de inhoud of het om normaal, diepvries of diepvries visserijproduct gaat.
12. De agent downloadt de actuele `Labels_13_talen.xlsx` uit `Database/`.
13. De agent downloadt het juiste Word-sjabloon uit `Templates/`.
14. De agent zoekt per tekstveld eerst naar een match in de vertalingendatabase.
15. Bij ingredientendeclaraties werkt dit op termniveau: bekende termen zoals `water` worden groen/trusted verwerkt, AI high-confidence termen worden paars en onzekere delen blijven rood.
16. Als een volledige tekst of term niet betrouwbaar in de database staat, gaat die naar OpenAI fallback.
17. OpenAI krijgt geen volledige SharePoint-map en geen Word-template als bestand. OpenAI krijgt alleen de relevante tekstvelden, productcontext, bekende database-terminologie en onbekende termen.
18. De agent vult het Word-sjabloon met de gevonden waarden en vertalingen.
19. De agent markeert automatisch ingevulde/trusted output groen, AI high-confidence output paars en onzekere reviewoutput rood.
20. De agent maakt daarnaast een korte rapportage voor Make met onderwerp, tekstversie en HTML-versie.
21. Het Word-label wordt geupload naar `Output/YYYY-MM-DD/` in SharePoint.
22. De rapportage wordt als `.txt` opgeslagen in dezelfde outputmap.
23. De agent voegt een regel toe aan `Run log/label-agent-runs.xlsx`.
24. Make pollt `GET /labels/{runId}` totdat de status `completed` is.
25. Make gebruikt daarna `sharePointWebUrl` voor het label en `emailReport.html` of `emailReport.text` voor de e-mail.

## Hoe Flexibel De Specificatie Wordt Gelezen

De agent leest niet alleen vaste cellen zoals "B12" of "C18". De parser in `src/excel/specParser.js` zoekt naar herkenbare labels, tekstblokken en waarden rond de relevante onderdelen van sheet `2. BASIC`. Daardoor kan de agent kleine verschuivingen in de Excel meestal opvangen.

Bewust gekozen voor een hybride aanpak:

- Objectieve velden zoals artikelnummer, gewicht, EAN en voedingswaarden worden door code uit de Excel gehaald, omdat dit traceerbaar en controleerbaar moet blijven.
- Taalvelden en juridisch gevoelige vertalingen worden eerst tegen de eigen database gecontroleerd.
- AI wordt gebruikt waar flexibiliteit nodig is, maar alleen als fallback en altijd met reviewmarkering.

Als een specificatie sterk afwijkt van de bekende structuur, kan de parser alsnog iets missen. In dat geval komt dit als QA-waarschuwing of reviewpunt terug in de output en run-log.

## Vertalingen En OpenAI

`Labels_13_talen.xlsx` is de leidende database. Alles wat daar goed in staat, beschouwen we als goedgekeurde terminologie.

De agent gebruikt OpenAI alleen wanneer:

- een productnaam of wettelijke benaming geen databasehit heeft;
- een waarschuwing of gebruikstekst geen databasehit heeft;
- een ingredientendeclaratie onbekende termen bevat;
- visserijvelden zoals vangstgebied, productiemethode of vangstmethode niet in de database staan.

Voor ingredientendeclaraties stuurt de agent ook de bekende termen uit de database mee als verplichte terminologie. De bedoeling is dat OpenAI niet vrij gaat "mooie vertalingen" maken, maar juridisch conservatieve labelbenamingen voorstelt. Als `OPENAI_ENABLE_WEB_SEARCH=true` staat, mag de fallback ook web search gebruiken binnen de ingestelde OpenAI tooling.

Alle OpenAI-output blijft reviewplichtig. Als OpenAI aangeeft dat de onderzochte vertaling high-confidence is, wordt deze paars in het document gezet. Als OpenAI onzeker is, als context ontbreekt of als fallback faalt, wordt de tekst rood gezet. QA kan goedgekeurde paarse/rode termen later toevoegen aan de vertalingendatabase, zodat ze bij volgende runs groen worden.

## Kleurcodering In Het Label

De kleurcodering is bedoeld om QA snel te laten zien wat automatisch is gedaan en wat extra controle nodig heeft.

- Groen: automatisch ingevulde waarden of termen/vertalingen uit `Labels_13_talen.xlsx`.
- Paars: OpenAI fallback/research met hoge zekerheid, maar nog niet afkomstig uit `Labels_13_talen.xlsx`.
- Rood: OpenAI fallback met twijfel, fallback-fout, onbekende ingredientdelen of manual-required tekst.
- Ongemarkeerd: vaste tekst die al in het Word-sjabloon stond en niet door de agent is vervangen.

Bij ingredientendeclaraties gebeurt de markering per herkende term. Daardoor kan een regel tegelijk groen, paars en rood bevatten: database-termen groen, AI high-confidence termen paars en onzekere delen rood.

## Output En Run-Log

Per run maakt de agent drie soorten output in SharePoint:

- Het ingevulde Word-label in `Output/YYYY-MM-DD/`.
- Een korte tekstuele rapportage in `Output/YYYY-MM-DD/`.
- Een nieuwe regel in `Run log/label-agent-runs.xlsx`.

De run-log bevat onder andere:

- run ID en timestamp;
- mailonderwerp en bronbestand;
- artikelnummer, leverancier, merk en productnaam;
- gekozen sjabloon;
- SharePoint-pad en SharePoint-link naar de output;
- reviewstatus;
- reviewpunten;
- gebruikte OpenAI modellen;
- aantal bekende databasehits en fallbackpunten;
- QA-waarschuwingen vanuit de spec of vertalingendatabase.

## API

Health check:

```http
GET /health
```

Label-run starten met multipart upload vanuit Make:

```http
POST /labels?async=true
Authorization: Bearer <MAKE_WEBHOOK_SECRET>
Content-Type: multipart/form-data

spec=<xlsx file>
emailSubject=<mail subject>
```

Label-run starten met een bestand dat al in SharePoint staat:

```http
POST /labels?async=true
Authorization: Bearer <MAKE_WEBHOOK_SECRET>
Content-Type: application/json

{
  "sharePointSpecPath": "Input/spec.xlsx",
  "emailSubject": "Nieuwe specificatie"
}
```

Directe response bij async starten:

```json
{
  "status": "processing",
  "runId": "20260811121245-69gxbv",
  "pollAfterSeconds": 20,
  "statusUrl": "https://.../labels/20260811121245-69gxbv"
}
```

Status ophalen:

```http
GET /labels/{runId}
Authorization: Bearer <MAKE_WEBHOOK_SECRET>
```

Response als de run klaar is:

```json
{
  "status": "completed",
  "runId": "20260811121245-69gxbv",
  "templateType": "fisheryFrozen",
  "articleNumber": "7788-01",
  "sharePointOutputPath": "Output/2026-08-11/label.docx",
  "sharePointWebUrl": "https://...",
  "sharePointReportPath": "Output/2026-08-11/rapportage.txt",
  "sharePointReportWebUrl": "https://...",
  "reviewRequired": true,
  "reviewItems": [],
  "emailReport": {
    "subject": "Label 7788-01 - review nodig",
    "text": "platte tekst voor Make mailbody",
    "html": "<div>HTML-versie voor Make mailbody</div>"
  }
}
```

Tijdens verwerking geeft de status endpoint `202` terug met `status=processing`. Bij een fout geeft de endpoint `500` terug met `status=failed`.

## Railway Configuratie

Railway start de service met:

```bash
npm start
```

De service luistert op `process.env.PORT`. Railway vult deze variabele normaal zelf in. Daarom moet er in Railway geen vaste poort hardcoded worden.

Belangrijke environment variables:

| Variable | Doel |
| --- | --- |
| `PUBLIC_BASE_URL` | Publieke Railway URL, zodat de agent volledige `statusUrl` waarden kan teruggeven. |
| `MAKE_WEBHOOK_SECRET` | Bearer token waarmee Make de agent mag aanroepen. |
| `SHAREPOINT_TENANT_ID` | Microsoft tenant ID. |
| `SHAREPOINT_CLIENT_ID` | App registration client ID. |
| `SHAREPOINT_CLIENT_SECRET` | App registration secret. |
| `SHAREPOINT_SITE_ID` | SharePoint site ID, of leeg als Teams channel mode voldoende is. |
| `SHAREPOINT_DRIVE_ID` | SharePoint drive/document library ID, indien nodig. |
| `TEAMS_TEAM_ID` | Team ID van het Teams-team. |
| `TEAMS_CHANNEL_ID` | Channel ID van het kanaal met de bestanden. |
| `SP_TRANSLATION_DB_PATH` | Pad naar `Database/Labels_13_talen.xlsx`. |
| `SP_TEMPLATE_NORMAL_PATH` | Pad naar het normale Word-sjabloon. |
| `SP_TEMPLATE_FROZEN_PATH` | Pad naar het diepvries Word-sjabloon. |
| `SP_TEMPLATE_FISHERY_FROZEN_PATH` | Pad naar het diepvries visserijproduct Word-sjabloon. |
| `SP_INPUT_FOLDER` | SharePoint inputmap, meestal `Input`. |
| `SP_OUTPUT_FOLDER` | SharePoint outputmap, meestal `Output`. |
| `SP_RUN_LOG_PATH` | Pad naar `Run log/label-agent-runs.xlsx`. |
| `OPENAI_API_KEY` | OpenAI API key voor fallback/research. |
| `OPENAI_MODEL` | Standaardmodel voor alle niet-ingredient velden, nu meestal `gpt-5-mini`. |
| `OPENAI_REVIEW_MODEL` | Optioneel zwaarder model voor ingredientendeclaraties, meestal `gpt-5`. |
| `OPENAI_ENABLE_FALLBACK` | Zet OpenAI fallback aan of uit. |
| `OPENAI_ENABLE_MODEL_ESCALATION` | Laat ingredientendeclaraties escaleren naar het reviewmodel. Andere velden blijven op `OPENAI_MODEL`. |
| `OPENAI_ENABLE_WEB_SEARCH` | Laat OpenAI fallback web search gebruiken waar relevant. |
| `OPENAI_CONFIDENCE_PURPLE_THRESHOLD` | Zekerheidsdrempel voor paarse AI-output, standaard `0.8`. |
| `OPENAI_TIMEOUT_MS` | Timeout voor OpenAI calls. |

## Microsoft Graph Rechten

De app registration gebruikt app-only toegang. Hiervoor is admin consent nodig. De agent moet bestanden kunnen lezen en schrijven in de SharePoint/Teams-map.

Praktische rechten zijn:

- `Files.ReadWrite.All`
- `Sites.ReadWrite.All`

Een strakkere inrichting kan met `Sites.Selected`, mits de app expliciet rechten krijgt op de juiste SharePoint-site.

## Make Scenario

In Make gebruik ik deze flow:

1. Mailhook ontvangt de e-mail.
2. HTTP module stuurt de spec als multipart veld `spec` naar `POST /labels?async=true`.
3. De Authorization header is `Bearer <MAKE_WEBHOOK_SECRET>`.
4. Make krijgt direct `runId` en `statusUrl` terug.
5. Een repeater of sleep wacht ongeveer 20 tot 30 seconden.
6. Make doet `GET` naar de `statusUrl`.
7. Als `status=processing`, wacht Make opnieuw en pollt nogmaals.
8. Als `status=completed`, gebruikt Make `emailReport.subject` en `emailReport.html` of `emailReport.text` voor de mail.
9. Make voegt de link naar `sharePointWebUrl` toe als outputlabel.
10. Als `reviewRequired=true`, gaat de mail naar QA/human check.

## Code-Indeling

De belangrijkste bestanden zijn:

- `src/server.js`: Express API voor `/health`, `POST /labels` en `GET /labels/{runId}`.
- `src/labelAgent.js`: hoofdorchestratie van een complete label-run.
- `src/config.js`: leest alle Railway environment variables.
- `src/sharepoint/graphClient.js`: Microsoft Graph download/upload en Teams-kanaalmap resolutie.
- `src/excel/specParser.js`: leest sheet `2. BASIC` en haalt productdata uit de specificatie.
- `src/translation/translationDb.js`: laadt en indexeert `Labels_13_talen.xlsx`.
- `src/translation/translator.js`: vertaalt normale velden via database of OpenAI fallback.
- `src/translation/ingredientDeclaration.js`: vertaalt ingredientendeclaraties op termniveau met groen/paars/rood segmenten.
- `src/translation/openaiFallback.js`: OpenAI fallback/research met modelkeuze en optionele web search.
- `src/docx/docxTemplate.js`: vult het Word-sjabloon en past kleurcodering toe.
- `src/report/emailReport.js`: maakt de korte Make-ready rapportage.
- `src/runLog.js`: schrijft de run-log terug naar Excel in SharePoint.

## Security En Compliance

De agent is zo ingericht dat de eigen vertalingendatabase leidend blijft. OpenAI mag ontbrekende vertalingen voorstellen, maar deze output wordt nooit automatisch als definitief goedgekeurd. High-confidence AI-output wordt paars gemarkeerd, onzekere AI-output wordt rood gemarkeerd, en beide blijven zichtbaar voor menselijke QA-controle.

De agent bewaart tijdens een run tijdelijk bestanden onder `tmp/` in de Railway container. Na een succesvolle run wordt de tijdelijke runmap verwijderd. De blijvende output staat in SharePoint.

De jobstatus voor polling staat in memory in de Railway container. De output en run-log staan wel permanent in SharePoint. Als Railway precies tijdens een run herstart, kan de pollingstatus verloren gaan en moet Make de run opnieuw starten.

## Beheerafspraken

- QA beheert de juridische terminologie in `Database/Labels_13_talen.xlsx`.
- QA beheert de Word-sjablonen in `Templates/`.
- IT beheert de Railway environment variables en Microsoft Graph app registration.
- IT in Make beheert de mailhook, HTTP-call, polling en mailafhandeling.
- Rode output in het label betekent altijd: controleren voordat dit als definitief label gebruikt wordt.
