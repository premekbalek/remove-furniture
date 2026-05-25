# Vymazani nabytku z fotky

Jednoducha webova aplikace pro nahrani fotky mistnosti, odstraneni nabytku pomoci OpenAI Image API a stazeni vysledku.

## Spusteni

1. Vytvorte `.env` podle `.env.example`.
2. Doplnte `OPENAI_API_KEY`.
3. Spustte aplikaci:

```bash
npm start
```

Otevrete `http://localhost:3000`.

## Poznamky ke kvalite

Aplikace zachovava vysokou kvalitu renderovani a format vstupni fotky. Pro webovy vystup standardne omezuje delsi hranu na 2048 px a celkovou velikost na 3 686 400 pixelu, aby negenerovala zbytecne drahe originalni rozliseni z mobilnich fotoaparatu.

Limity lze zmenit pres `OPENAI_MAX_OUTPUT_EDGE` a `OPENAI_MAX_OUTPUT_PIXELS`. Model zaroven vyzaduje, aby hrany byly nasobkem 16, delsi hrana mela maximalne 3840 px a pomer stran neprekrocil 3:1.
