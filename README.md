# Vymazani nabytku z fotky

Jednoducha webova aplikace pro nahrani fotky mistnosti, odstraneni nabytku pomoci OpenAI Image API a stazeni vysledku.

## Upravy

Aplikace podporuje dva navazujici rezimy:

- `Odstranit nabytek`: nabytek lze popsat textem, nebo ho na pracovni fotce oznacit prstem ci mysi a zadat odstraneni.
- `Retusovat fotku`: na pracovni fotce oznacte misto a do chatu napiste pozadovanou lokalni opravu.

Rezimy lze kombinovat. Kazda dalsi uprava vychazi z posledniho vysledku, zatimco vlevo zustava puvodni fotka pro porovnani. Cervene oznaceni slouzi pouze k vyznaceni mista, ktere ma uzivatel na mysli; do chatu je stale potreba napsat, co se ma s oznacenou oblasti stat. Mimo cervene oznaceni se po navratu z API znovu pouzije puvodni pracovni fotka, aby se nezmenily neoznacene casti. Vysledky se ukladaji jako JPG.

Tlacitko `Storno` zrusi sledovani probihajici ulohy a server uz jeji vysledek nepouzije. Tlacitko `Krok zpet` vrati posledni povedenou upravu v aktualne otevrene strance.

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

Kvalitu lze nastavit pres `OPENAI_IMAGE_QUALITY` (`high` pro finalni vystup, `medium` pro levnejsi testovani). Limity rozmeru lze zmenit pres `OPENAI_MAX_OUTPUT_EDGE` a `OPENAI_MAX_OUTPUT_PIXELS`. Model zaroven vyzaduje, aby hrany byly nasobkem 16, delsi hrana mela maximalne 3840 px a pomer stran neprekrocil 3:1.

## Zpracovani na mobilu

Po odeslani fotky server pokracuje ve zpracovani i kdyz uzivatel prepne tab nebo zamkne telefon. Prohlizec si uklada identifikator probihajici ulohy a po navratu si vyzvedne vysledek. Hotove vysledky jsou docasne uchovany pouze v pameti serveru po dobu jedne hodiny, maximalne deset vysledku; neukladaji se na disk ani do databaze.
