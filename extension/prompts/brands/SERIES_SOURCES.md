# Библиотека серий брендов

Этот файл фиксирует происхождение закрытых словарей из `prompt-profiles.js` и
одноимённых брендовых профилей. Поиск в интернете выполняется моделью во время
генерации только для определения кандидата для конкретного артикула. Найденное
значение проходит сверку с локальным словарём. Страница или продавец не могут
добавить новую серию в словарь автоматически.

## Casio

Канонические значения: `Classic`, `G-SHOCK`, `BABY-G`, `EDIFICE`, `PRO TREK`,
`OCEANUS`, `SHEEN`, `CASIO VINTAGE`, `CASIO COLLECTION`, `CASIOTRON`, `MR-G`,
`MT-G`, `G-STEEL`, `MASTER OF G`, `G-SHOCK MOVE`, `G-MS`, `G-LIDE`, `LINEAGE`,
`DATA BANK`.

Источники: [обзор брендов Casio](https://www.casio.com/europe/watches/brandsites-overview/),
[коллекции G-SHOCK](https://gshock.casio.com/us/products/collection/),
[OCEANUS](https://www.casio.com/us/watches/oceanus/about/).

## Orient

Канонические значения: `Classic`, `Sports`, `Contemporary`, `Bambino`, `Mako`,
`Mako 40`, `Kamasu`, `Orient Star`, `Orient Star Classic`, `Orient Star Contemporary`,
`Orient Star Sports`, `Sun & Moon`, `Stretto`, `iO`, `Defender`, `Symphony`,
`TriStar`, `Open Heart`, `Revival`, `Neo Classic`.

Источники: [официальный магазин Orient](https://store.orient-watch.com/),
[Orient Star](https://orient-watch.com/en/orientstar/),
[фильтры коллекций Orient Star](https://orient-watch.com/en/orientstar/search/?rt_bn_products_list_chip_def_skip=60&rt_bn_products_list_def_skip=&rt_bn_products_list_expensive_def_skip=60&rt_bn_products_list_release_def_skip=36).

## Tissot

Канонические значения: `Ballade`, `Bellissima`, `Carson`,
`Chemin des Tourelles`, `Chrono L`, `Classic Dream`, `Desir`, `Everytime`,
`Flamingo`, `Gentleman`, `Goldrun`, `Heritage 1938`, `Le Locle`, `Lepine`,
`Lovely`, `Nordic`, `Pinarello`, `PR 100`, `PR 100 Jungfraubahn`, `PR 516`,
`PRC 100 Solar`, `PRC 200`, `PRS 516`, `PRX`, `PRX Digital`, `Rockwatch`,
`Savonnette`, `Seastar`, `SRV`, `Supersport`, `Supersport Chrono`, `T-Complication`,
`T-Race`, `T-Race MotoGP`, `T-Wave`, `Tradition`, `T-Touch`, `T-Touch Connect Solar`,
`T-My Lady`, `Visodate`, `XL`.

Источник: [официальная коллекция Tissot](https://www.tissotwatches.com/en-en/collection.html).

## Pagani Design

Для Pagani Design словарь серий отключён. PD-код, тип часов, механизм, категория
и homage-название не используются как дополнительная строка заголовка. Блок названия
фиксирован: `Pagani` / `Design` / полный PD-код.

Источники бренда используются только для проверки фактов и УТП конкретной модели:
[все часы Pagani Design](https://paganidesign.com/en-us/collections/all-watches),
[мужская коллекция](https://paganidesign.com/en-us/collections/men).

## Benyar

Канонические значения: `Casual Date`, `Moonphase`, `Grand Master`,
`Strom`, `Skeleton`, `SportX`, `Fusion`, `Alpha Date`, `Zenith Jubilee`, `Kiko`,
`Insider`, `Corporate`, `Exclusive`, `Chrono Master`, `Ultrachron`, `Royal Auto`.

Для Benyar названия серий сверяются особенно строго: доступные каталоги бренда и
региональные магазины используют маркетинговые названия неодинаково. Поэтому
название допускается только при связи с точным BY-кодом. При отсутствии подтверждения
профиль включает режим без серии и переносит точное название бренда на позицию второй
строки блока названия.

Источники для проверки: [Benyar Pakistan](https://benyar.com.pk/),
[каталог mechanical](https://benyarwatch.com/collections/mechanical),
[каталог Benyar](https://benyarofficial.com/collections/all).

## Q&Q

Канонические значения: `SmileSolar`, `Superior`, `Sports`, `Fashion`,
`Digital`, `Elegant`, `Ladies`, `Series 003`, `Series 004`, `Matching Style Series 002`,
`Mini Series`, `20BAR Series`, `STAR WARS Collection`, `Peanuts Collection`,
`Disney Collection`, `Champion Collection`, `CAPTAIN STAG Collaboration`,
`PAPIER TIGRE Collaboration`, `Q&Q SmileSolar BY groovisions`,
`THE PARK SHOP Collaboration`, `OSAMU GOODS Collaboration`,
`kaoyorinakami Collaboration`, `Suzuki Masaru Collaboration`.

Источник: [официальные коллекции Q&Q SmileSolar](https://www.smile-qq.com/collections).

## Seiko

Канонические значения: `Prospex`, `Prospex Alpinist`, `Prospex Speedtimer`,
`Prospex Diver Scuba`, `Prospex Marinemaster`, `Presage`, `Presage Classic Series`,
`Presage Cocktail Time`, `Presage Style60’s`, `Presage Inspired by Japanese Gardens`,
`Presage Sharp Edged Series`, `Astron`, `Astron GPS Solar`, `5 Sports`, `5 Sports SKX`,
`5 Sports Field`, `5 Sports SNXS`, `King Seiko`, `King Seiko KSK`, `King Seiko VANAC`,
`King Seiko KS1969`, `Premier`, `Coutura`, `Lukia`, `Alpinist`, `Recraft`, `Selection`,
`Spirit`.

Источник: [официальная коллекция Seiko Presage](https://www.seikowatches.com/us-en/products/presage).

## Citizen

Канонические значения: `Eco-Drive`, `Eco-Drive One`, `Promaster`,
`Promaster Marine`, `Promaster Sky`, `Promaster Land`, `Tsuyosa`, `Series8`,
`Series8 831`, `Series8 870`, `Series8 880 GMT`, `Series8 890`, `The Citizen`,
`Attesa`, `Satellite Wave`, `Super Titanium`, `Citizen L`, `Corso`, `Calendrier`,
`PCAT`, `Silhouette Crystal`.

Источники: [официальные коллекции Citizen](https://www.citizenwatch.com/on/demandware.store/Sites-citizen_US-Site/default/),
[Series8](https://www.citizenwatch.com/us/en/collection/series-8).

## Longines

Канонические значения: `Master Collection`, `Master Collection GMT`,
`Master Collection Chronograph`, `Master Collection Moonphase`, `HydroConquest`,
`HydroConquest GMT`, `Spirit`, `Spirit Zulu Time`, `Spirit Flyback`,
`Spirit Chronograph`, `Conquest`, `Conquest Classic`, `Conquest Chronograph`,
`Conquest Heritage`, `Flagship`, `Flagship Classic`, `Flagship Heritage`, `DolceVita`,
`Mini DolceVita`, `La Grande Classique`, `Présence`, `Record`, `Legend Diver`,
`Ultra-Chron`, `Pilot Majetek`, `Heritage Classic`, `Heritage Military`, `Evidenza`,
`PrimaLuna`, `Elegant Collection`, `Avigation`, `Lindbergh Hour Angle`.

Источники: [официальный сайт Longines](https://www.longines.com/en-us),
[Spirit Zulu Time](https://www.longines.com/en-us/watches/spirit/spirit-zulu-time),
[Conquest Heritage](https://www.longines.com/en-us/watches/heritage/conquest-heritage),
[Heritage](https://www.longines.com/en-us/watches/heritage).

## Diesel

Канонические значения: `Mega Chief`, `Mr. Daddy`, `Griffed`, `Overflow`,
`Double Down`, `Rasp`, `Little Daddy`, `Mini Daddy`, `Scraper`, `Stinger`, `Spiked`,
`Mercurial`, `Vert`, `Closer`, `D-Era`, `D-Curve`, `Streamline`, `Framed`, `Armbar`,
`Metamorph`.

Источники: [официальные мужские часы Diesel](https://diesel.com/en-us/man/watches/),
[Mr. Daddy](https://diesel.com/en-us/man/watches/watches/mr-daddy/).

## Armani Exchange

Канонические значения: `A|X Sync`, `A|X Bass`, `A|X Audora`, `Digital`,
`Hampton`, `Drexler`, `Hugo`, `Outerbanks`, `AX Chronograph`.

Источники: [официальные часы Armani Exchange](https://www.armani.com/en/armani-exchange/man/watches/),
[A|X watch experience](https://www.armani.com/en-ie/armani-exchange/experience/armani-exchange-watches-spring-summer/),
[Sync](https://www.armani.com/en-ae/armani-exchange/experience/armani-exchange-sync/).

## Certina

Канонические значения: `DS+`, `DS-1`, `DS-2`, `DS-6`, `DS-7`, `DS-8`,
`DS Action`, `DS PH`, `DS Caimano`, `DS Jubile`, `DS`, `DS Podium`, `DS-X`.

Источник: [официальная коллекция Certina](https://www.certina.com/en/the-collection).

## Политика неизвестных брендов

Для неизвестного бренда профиль не содержит разрешённых серий. Веб-поиск может помочь
понять модель и характеристики, однако неизвестное название серии не попадает в
карточку до создания отдельного проверенного профиля и его локального словаря. До
этого используется режим без серии: первая строка блока названия пустая, бренд стоит
на позиции второй строки, код — на фиксированной третьей позиции.
