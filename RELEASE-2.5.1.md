# Stream Hub 2.5.1

Opravné vydanie založené na v2.5. Android versionName: 2.5.1, versionCode: 36. Podpisový certifikát zodpovedá pôvodnej APK v2.5; zachováva sa pôvodný spôsob podpisovania.

## Opravy

- SledujTeTo: vlastné HTTP hlavičky už neodstraňujú prihlasovacie cookies; kontrola Premium rozlišuje aktívny a neaktívny stav.
- Presnejšie rozpoznávanie epizód vrátane sezóny 0; vyhľadávanie skúša aj názov bez roku a označenie 1x02.
- Vyhľadávanie zachováva znak & v názve. Fastshare používa stabilné náhradné ID a zakódované vyhľadávacie adresy.
- Prehraj.to skúsi prehrávací odkaz zo stránky aj po zlyhaní požiadavky na pôvodný súbor; odmieta presmerovania na bežné webové stránky.
- Obmedzená cache údajov o súboroch sa ukladá na disk a zachováva sa pri aktualizácii APK. Časovo obmedzené prehrávacie URL poskytovateľov tým nezískavajú neobmedzenú platnosť.
- Prihlásenia k jednej službe sa vykonávajú sériovo; neúspech alebo odhlásenie zneplatní stav relácie.
- Preložený názov filmu sa už nevydáva za dôkaz CZ/SK zvukovej stopy.
- Správa zo siete vyžaduje párovací kód z lokálnej aplikácie; prehrávacie endpointy zostávajú dostupné klientom. LAN adresu možno vybrať v menu.
- Súbežné pridávanie doplnkov do účtu sa vykonáva sériovo.
- Zastavenie servera ukončí aj aktívne proxy prenosy; heslá sa neposielajú orezané o medzery.
- OTA overuje syntax, verziu a prípadný SHA-256, následne nahrádza súbor atómovo so zálohou.

## Overenie

12 automatizovaných regresných testov; kontrola syntaxe generovaného JavaScriptu; lokálny test HTTP servera a konfiguračného rozhrania. Android APK zostavená pomocou Gradle a jej podpis overený voči v2.5. Živé prehrávanie všetkých poskytovateľov a inštalácia na fyzickom telefóne neboli súčasťou tohto overenia.

## Aktualizácie

Toto vydanie má vlastný aktualizačný kanál `fix/v2.5.1`. Nenahrádza main ani označenie latest vydania v3.0. Z v2.5 ho nainštalujte stiahnutím priloženej APK. Nevydáva sa nový Windows inštalátor.

Zdrojový Android projekt a testy sú v samostatnom archíve zdrojov. Podpisovací kľúč ani používateľská konfigurácia sa nezverejňujú.
