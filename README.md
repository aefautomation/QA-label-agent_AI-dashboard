# Label Agent

HTTP-agent voor Make/Railway die uit productspecificaties een meertalig labeldocument maakt.

## Werkwijze

1. Make ontvangt een mail via mailhook en stuurt de productspecificatie door naar `POST /labels`.
2. De agent leest sheet `2. BASIC` uit de specificatie.
3. De agent kiest het juiste Word-sjabloon:
   - normaal
   - diepvries
   - diepvries + visserijproduct
4. Vertalingen komen eerst uit `Labels_13_talen.xlsx`.
5. Ontbrekende vertalingen gaan via OpenAI fallback. Het standaardmodel wordt gebruikt voor normale gevallen; een optioneel reviewmodel wordt alleen gebruikt voor juridisch gevoeligere fallbackgevallen.
6. Tekst buiten de vertalingendatabase wordt rood in het Word-document gezet en komt in het reviewrapport.
7. Output en run-log worden teruggeschreven naar SharePoint.

## Teams/SharePoint mappen

Gebruik het Teams-kanaal als bron van waarheid. Bestanden die in een Teams-kanaal staan worden door Microsoft in de gekoppelde SharePoint-map van dat kanaal opgeslagen. De agent kan die kanaalmap direct via Microsoft Graph gebruiken.

Zet in het kanaal `Automatisering` deze structuur:

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

De Excel met vertalingen en de sjablonen blijven gewone bewerkbare Office-bestanden. De agent downloadt bij elke run de actuele versies uit de Teams-kanaalmap, dus wijzigingen zijn meteen actief zonder redeploy.

Eenmalig vullen vanuit de huidige lokale bestanden kan met:

```bash
npm run bootstrap:teams
```

Dit script maakt `Input`, `Output` en `Run log` aan en uploadt de huidige templates plus `Labels_13_talen.xlsx`.

### Teams channel mode

Stel deze variabelen in Railway in:

- `TEAMS_TEAM_ID`
- `TEAMS_CHANNEL_ID`

Deze IDs kun je ophalen via Microsoft Graph:

```http
GET /teams/{team-id}/channels
GET /teams/{team-id}/channels/{channel-id}/filesFolder
```

De tweede call geeft de echte SharePoint-map terug die Teams gebruikt voor de kanaalbestanden.

Als deze twee waarden zijn gezet, zijn alle `SP_*` paden relatief aan de bestandenmap van dat kanaal:

```env
SP_TRANSLATION_DB_PATH=Database/Labels_13_talen.xlsx
SP_TEMPLATE_NORMAL_PATH=Templates/BI09-....docx
SP_TEMPLATE_FROZEN_PATH=Templates/BI13-....docx
SP_TEMPLATE_FISHERY_FROZEN_PATH=Templates/BI53-....docx
SP_OUTPUT_FOLDER=Output
SP_RUN_LOG_PATH=Run log/label-agent-runs.xlsx
```

Zonder `TEAMS_TEAM_ID` en `TEAMS_CHANNEL_ID` gebruikt de agent de SharePoint document library root zoals eerder.

### OpenAI modellen

De agent gebruikt OpenAI alleen als fallback wanneer een tekst niet betrouwbaar uit `Labels_13_talen.xlsx` komt.

```env
OPENAI_MODEL=gpt-5-mini
OPENAI_REVIEW_MODEL=gpt-5
OPENAI_ENABLE_MODEL_ESCALATION=true
```

`OPENAI_MODEL` is het standaardmodel. `OPENAI_REVIEW_MODEL` wordt alleen gebruikt bij:

- ingredientendeclaraties met onbekende termen
- productnaam/wettelijke benaming zonder databasehit
- waarschuwingen zonder databasehit
- visserijvelden zonder databasehit

Als `OPENAI_REVIEW_MODEL` leeg is, gebruikt de agent altijd `OPENAI_MODEL`. Alle fallback-output blijft reviewplichtig en rood in het Word-document.

### Bewerken door QA/marketing

- Pas vertalingen alleen aan in `Database/Labels_13_talen.xlsx` in het Teams-kanaal.
- Pas layout, vaste labelteksten en taalvolgorde aan in de `.docx` bestanden onder `Templates/`.
- Laat bestandsnamen gelijk, of pas de bijbehorende `SP_TEMPLATE_*` environment variable aan.
- De agent wijzigt de template/databasebestanden niet; hij maakt per run een nieuw output-document.

### Run-log

De agent maakt of werkt `Run log/label-agent-runs.xlsx` bij met:

- run ID en timestamp
- bronbestand / mailonderwerp
- artikelnummer, leverancier, merk en wettelijke productnaam
- gekozen sjabloon
- SharePoint-outputpad
- reviewstatus
- aantal databasehits versus fallback-vertalingen
- gebruikte OpenAI modellen en aantal reviewmodel-escalaties
- QA-waarschuwingen als JSON

## API

### Health

```http
GET /health
```

### Label maken

Multipart upload:

```http
POST /labels
Authorization: Bearer <MAKE_WEBHOOK_SECRET>
Content-Type: multipart/form-data

spec=<xlsx file>
```

JSON met SharePoint-pad:

```http
POST /labels
Authorization: Bearer <MAKE_WEBHOOK_SECRET>
Content-Type: application/json

{
  "sharePointSpecPath": "Label Agent/Input/spec.xlsx",
  "emailSubject": "Nieuwe specificatie"
}
```

De response is JSON met `runId`, gekozen sjabloon, reviewstatus, SharePoint-outputpad en een kant-en-klare mailrapportage:

```json
{
  "emailReport": {
    "subject": "Label DV7837-01 - review nodig",
    "text": "platte tekst voor Make mailbody",
    "html": "<div>HTML-versie voor Make mailbody</div>"
  },
  "reportPath": "outputs/.../...-rapportage.txt",
  "sharePointReportPath": "Output/2026-08-11/...-rapportage.txt",
  "sharePointReportWebUrl": "https://..."
}
```

## Railway

Zet de variabelen uit `.env.example` in Railway. Voor SharePoint gebruikt de agent Microsoft Graph met app-only credentials:

- `SHAREPOINT_TENANT_ID`
- `SHAREPOINT_CLIENT_ID`
- `SHAREPOINT_CLIENT_SECRET`
- `SHAREPOINT_SITE_ID`
- `SHAREPOINT_DRIVE_ID`
- `TEAMS_TEAM_ID`
- `TEAMS_CHANNEL_ID`

Voor Teams channel mode gebruikt de agent `GET /teams/{team-id}/channels/{channel-id}/filesFolder` om de juiste SharePoint-map van het kanaal te vinden. Voor de Graph-app is lees/schrijfrecht op de bestanden nodig. Praktisch kan dit met `Files.ReadWrite.All` of `Sites.ReadWrite.All`; strenger kan met `Sites.Selected` mits de app expliciet rechten krijgt op de juiste site.

## Make scenario

Aanbevolen flow:

1. Mailhook ontvangt mail met productspecificatie.
2. Make uploadt de spec naar `Input/` in het Teams-kanaal, of stuurt hem direct multipart door.
3. Make roept `POST /labels` aan.
4. Make leest `emailReport.subject` en `emailReport.html` of `emailReport.text` uit de JSON-response voor de mail.
5. Make gebruikt `sharePointWebUrl` of `downloadUrl` voor het gemaakte Word-label.
6. Optioneel: voeg `sharePointReportWebUrl` of `reportDownloadUrl` toe als extra bijlage/link.
7. Bij `reviewRequired=true`: stuur naar QA/human check.

## Belangrijke compliance-regel

De agent mag ontbrekende vertalingen voorstellen, maar alles buiten de eigen vertalingsdatabase wordt rood gemarkeerd en vereist menselijke QA. Dit is expres streng: voedseletiketten zijn wettelijk gevoelige documenten.

Kleurcodering in het gegenereerde Word-label:

- groen: automatisch ingevuld door de agent, of vertaling/terminologie uit `Labels_13_talen.xlsx`; bij ingredientendeclaraties gebeurt dit per herkende term
- rood: vertaling/tekst staat niet betrouwbaar in `Labels_13_talen.xlsx` en is fallback/AI/manual-required; bij ingredientendeclaraties gebeurt dit per onbekend tekstdeel

Vaste sjabloontekst die niet door de agent is vervangen blijft ongemarkeerd.
