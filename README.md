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

Aplikace se snazi zachovat format a rozliseni vstupni fotky. Model ale vyzaduje podporovane rozmery: hrany musi byt nasobkem 16, delsi hrana muze byt maximalne 3840 px a pomer stran maximalne 3:1. Pokud fotka tyto limity nesplnuje, aplikace pouzije nejblizsi podporovany rozmer se stejnym pomerem stran.
