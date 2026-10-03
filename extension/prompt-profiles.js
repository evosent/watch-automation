import { buildInputPlan, renderReferenceAwareText } from './input-plan.js';

const MODEL_PLACEHOLDERS = Object.freeze([
  '[вставь нужную модель часов]',
  '{{MODEL_NAME}}'
]);

// Model codes vary considerably between brands. These two overlapping
// tokenisers cover contiguous codes (BY-S001-177-MD, L4.320.2.11.7) and the
// occasional spaced form (GA 2100 1A1). A look-ahead keeps candidates that
// begin after a collection/series prefix such as "G-SHOCK-" or "PRX ".
// The final extension is removed before matching so a filename can be passed
// directly.
const WATCH_REFERENCE_PATTERNS = Object.freeze([
  /(?=(\b[A-Z]{1,5}(?=[A-Z0-9.\-]*\d)[A-Z0-9]*(?:[-.][A-Z0-9]+){0,6}\b))/gi,
  /(?=(\b[A-Z]{1,5}(?=[A-Z0-9.\-\s]*\d)(?:[-.\s]+[A-Z0-9]+){1,6}\b))/gi
]);
const REFERENCE_NON_CODES = Object.freeze([
  /^SERIES[-\s]?\d+$/i,
  /^MODEL[-\s]?\d+$/i,
  /^TYPE[-\s]?\d+$/i,
  /^EDITION[-\s]?\d+$/i,
  /^VERSION[-\s]?\d+$/i
]);
const REFERENCE_BRAND_PREFIXES = new Set([
  'ARMANI', 'BENYAR', 'CASIO', 'CERTINA', 'CITIZEN', 'DESIGN', 'DIESEL',
  'EXCHANGE', 'LONGINES', 'ORIENT', 'PAGANI', 'Q', 'SEIKO', 'TISSOT'
]);
const REFERENCE_PREFIX_STOPWORDS = new Set([
  'BABY', 'CASIOTRON', 'CLASSIC', 'COLLECTION', 'DIGITAL', 'DS', 'DREAM',
  'EDIFICE', 'EVERYTIME', 'GENT', 'LADY', 'LOVELY', 'MASTER', 'PR', 'PRX',
  'PRO', 'SERIES', 'SHEEN', 'SPORT', 'STAR', 'TREK', 'VINTAGE'
]);

const LOOKALIKE_CHARACTERS = Object.freeze({
  а: 'a', с: 'c', е: 'e', о: 'o', р: 'p', х: 'x', у: 'y', і: 'i', ј: 'j',
  А: 'A', С: 'C', Е: 'E', О: 'O', Р: 'P', Х: 'X', У: 'Y', І: 'I', Ј: 'J'
});

function normalizeModelName(modelName) {
  return String(modelName || '').replace(/\s+/g, ' ').trim();
}

function matchingModelName(modelName) {
  return [...normalizeModelName(modelName)]
    .map((character) => LOOKALIKE_CHARACTERS[character] || character)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function alias(name, pattern) {
  return Object.freeze({ name, pattern });
}

// This is a controlled vocabulary. The filename resolver below only handles
// literal hints already present in the source filename. During generation the
// model may discover a series online, but it must map that result to this
// closed vocabulary before it can use the name in the card.
const BRAND_PROFILE_META = Object.freeze({
  casio: Object.freeze({
    displayName: 'Casio',
    promptPath: 'prompts/brands/casio.txt',
    fallbackSeries: 'Classic',
    seriesRequired: true,
    series: Object.freeze([
      'Classic', 'G-SHOCK', 'BABY-G', 'EDIFICE', 'PRO TREK', 'OCEANUS', 'SHEEN',
      'VINTAGE', 'COLLECTION', 'CASIOTRON', 'MR-G', 'MT-G', 'G-STEEL',
      'MASTER OF G', 'G-SHOCK MOVE', 'G-MS', 'G-LIDE', 'LINEAGE', 'DATA BANK'
    ]),
    aliases: Object.freeze([
      alias('CASIOTRON', /\bcasiotron\b/i),
      // The brand occupies line 1. Keep only the printable series token on
      // line 2 so Casio Vintage/Collection cannot become “Casio Casio …”.
      alias('VINTAGE', /\bcasio\s+vintage\b|\bvintage\b/i),
      alias('COLLECTION', /\bcasio\s+collection\b|\bcollection\b/i),
      alias('BABY-G', /\bbaby[-\s]?g\b/i),
      alias('G-SHOCK', /\bg[-\s]?shock\b/i),
      alias('PRO TREK', /\bpro\s+trek\b/i),
      alias('EDIFICE', /\bedifice\b/i),
      alias('OCEANUS', /\boceanus\b/i),
      alias('SHEEN', /\bsheen\b/i),
      alias('MASTER OF G', /\bmaster\s+of\s+g\b/i),
      alias('G-SHOCK MOVE', /\bg[-\s]?shock\s+move\b/i),
      alias('G-STEEL', /\bg[-\s]?steel\b/i),
      alias('MR-G', /\bmr[-\s]?g\b/i),
      alias('MT-G', /\bmt[-\s]?g\b/i),
      alias('G-MS', /\bg[-\s]?ms\b/i),
      alias('G-LIDE', /\bg[-\s]?lide\b/i),
      alias('LINEAGE', /\blineage\b/i),
      alias('DATA BANK', /\bdata\s+bank\b/i)
    ])
  }),
  orient: Object.freeze({
    displayName: 'Orient',
    promptPath: 'prompts/brands/orient.txt',
    fallbackSeries: null,
    series: Object.freeze([
      'Classic', 'Sports', 'Contemporary', 'Bambino', 'Mako', 'Mako 40', 'Kamasu',
      'Orient Star', 'Orient Star Classic', 'Orient Star Contemporary', 'Orient Star Sports',
      'Sun & Moon', 'Stretto', 'iO', 'Defender', 'Symphony', 'TriStar', 'Open Heart',
      'Revival', 'Neo Classic'
    ]),
    aliases: Object.freeze([
      alias('Orient Star', /\borient\s+star\b/i),
      alias('Sun & Moon', /\bsun\s*(?:&|and)\s*moon\b/i),
      alias('Mako 40', /\bmako\s+40\b/i),
      alias('Bambino', /\bbambino\b/i),
      alias('Kamasu', /\bkamasu\b/i),
      alias('Stretto', /\bstretto\b/i),
      alias('Mako', /\bmako\b/i),
      alias('Sports', /\bsports?\b/i),
      alias('Classic', /\bclassic\b/i),
      alias('Contemporary', /\bcontemporary\b/i),
      alias('Defender', /\bdefender\b/i),
      alias('Symphony', /\bsymphony\b/i),
      alias('TriStar', /\btristar\b|\btri[-\s]?star\b/i),
      alias('Open Heart', /\bopen\s+heart\b/i),
      alias('iO', /\bio\b/i),
      alias('Revival', /\brev[ií]val\b/i),
      alias('Neo Classic', /\bneo\s+classic\b/i)
    ])
  }),
  tissot: Object.freeze({
    displayName: 'Tissot',
    promptPath: 'prompts/brands/tissot.txt',
    fallbackSeries: null,
    series: Object.freeze([
      'Ballade', 'Bellissima', 'Carson', 'Chemin des Tourelles', 'Chrono L',
      'Classic Dream', 'Desir', 'Everytime', 'Flamingo', 'Gentleman', 'Goldrun',
      'Heritage 1938', 'Le Locle', 'Lepine', 'Lovely', 'Nordic', 'Pinarello',
      'PR 100', 'PR 100 Jungfraubahn', 'PR 516', 'PRC 100 Solar', 'PRC 200', 'PRS 516',
      'PRX', 'PRX Digital', 'Rockwatch', 'Savonnette', 'Seastar', 'SRV', 'Supersport',
      'Supersport Chrono', 'T-Complication', 'T-Race', 'T-Race MotoGP', 'T-Wave',
      'Tradition', 'T-Touch', 'T-Touch Connect Solar', 'T-My Lady', 'Visodate', 'XL'
    ]),
    aliases: Object.freeze([
      alias('Chemin des Tourelles', /\bchemin\s+des\s+tourelles\b/i),
      alias('Classic Dream', /\bclassic\s+dream\b/i),
      alias('PRX Digital', /\bprx\s+digital\b/i),
      alias('Everytime', /\beverytime\b/i),
      alias('Bellissima', /\bbellissima\b/i),
      alias('T-Wave', /\bt[-\s]?wave\b/i),
      alias('PRS 516', /\bprs\s*516\b/i),
      alias('PR 100', /\bpr\s*100\b/i),
      alias('T-Race', /\bt[-\s]?race\b/i),
      alias('T-Touch', /\bt[-\s]?touch\b/i),
      alias('Le Locle', /\ble\s+locle\b/i),
      alias('Lovely', /\blovely\b/i),
      alias('Seastar', /\bseastar\b/i),
      alias('Tradition', /\btradition\b/i),
      alias('Carson', /\bcarson\b/i),
      alias('Gentleman', /\bgentleman\b/i),
      alias('PRX', /\bprx\b/i),
      alias('Ballade', /\bballade\b/i),
      alias('Chrono L', /\bchrono\s+l\b/i),
      alias('Desir', /\bdesir\b|\bd[eé]sir\b/i),
      alias('Flamingo', /\bflamingo\b/i),
      alias('Goldrun', /\bgoldrun\b/i),
      alias('Heritage 1938', /\bheritage\s+1938\b/i),
      alias('Lepine', /\blepine\b/i),
      alias('Nordic', /\bnordic\b/i),
      alias('Pinarello', /\bpinarello\b/i),
      alias('PR 516', /\bpr\s*516\b/i),
      alias('PRC 100 Solar', /\bprc\s*100\s*solar\b/i),
      alias('PRC 200', /\bprc\s*200\b/i),
      alias('Rockwatch', /\brockwatch\b/i),
      alias('Savonnette', /\bsavonnette\b/i),
      alias('SRV', /\bsrv\b/i),
      alias('Supersport Chrono', /\bsupersport\s+chrono\b/i),
      alias('Supersport', /\bsupersport\b/i),
      alias('T-Complication', /\bt[-\s]?complication\b/i),
      alias('T-Race MotoGP', /\bt[-\s]?race\s+motogp\b/i),
      alias('T-Touch Connect Solar', /\bt[-\s]?touch\s+connect\s+solar\b/i),
      alias('T-My Lady', /\bt[-\s]?my\s+lady\b/i),
      alias('Visodate', /\bvisodate\b/i),
      alias('XL', /\bxl\b/i)
    ])
  }),
  pagani_design: Object.freeze({
    displayName: 'Pagani Design',
    promptPath: 'prompts/brands/pagani-design.txt',
    fallbackSeries: null,
    // Pagani Design uses two fixed brand lines followed by a smaller model
    // line. Product category words and homage references are excluded, and
    // this profile deliberately has no series vocabulary.
    series: Object.freeze([]),
    aliases: Object.freeze([])
  }),
  benyar: Object.freeze({
    displayName: 'Benyar',
    promptPath: 'prompts/brands/benyar.txt',
    fallbackSeries: null,
    series: Object.freeze([
      'Casual Date', 'Moonphase', 'Grand Master', 'Strom', 'Skeleton', 'SportX',
      'Fusion', 'Alpha Date', 'Zenith Jubilee', 'Kiko', 'Insider', 'Corporate', 'Exclusive',
      'Chrono Master', 'Ultrachron', 'Royal Auto'
    ]),
    aliases: Object.freeze([
      alias('Casual Date', /\bcasual\s+date\b/i),
      alias('Grand Master', /\bgrand\s+master\b/i),
      alias('Alpha Date', /\balpha\s+date\b/i),
      alias('Zenith Jubilee', /\bzenith\s+jubilee\b/i),
      alias('SportX', /\bsportx\b/i),
      alias('Moonphase', /\bmoonphase\b/i),
      alias('Skeleton', /\bskeleton\b/i),
      alias('Strom', /\bstrom\b/i),
      alias('Fusion', /\bfusion\b/i),
      alias('Kiko', /\bkiko\b/i),
      alias('Insider', /\binsider\b/i),
      alias('Corporate', /\bcorporate\b/i),
      alias('Exclusive', /\bexclusive\b/i),
      alias('Chrono Master', /\bchrono\s+master\b/i),
      alias('Ultrachron', /\bultrachron\b/i),
      alias('Royal Auto', /\broyal\s+auto\b/i)
    ])
  }),
  q_and_q: Object.freeze({
    displayName: 'Q&Q',
    promptPath: 'prompts/brands/q-and-q.txt',
    fallbackSeries: null,
    series: Object.freeze([
      'SmileSolar', 'Superior', 'Sports', 'Fashion', 'Digital', 'Elegant', 'Ladies',
      'Series 003', 'Series 004', 'Matching Style Series 002', 'Mini Series', '20BAR Series',
      'STAR WARS Collection', 'Peanuts Collection', 'Disney Collection', 'Champion Collection',
      'CAPTAIN STAG Collaboration', 'PAPIER TIGRE Collaboration',
      'Q&Q SmileSolar BY groovisions', 'THE PARK SHOP Collaboration', 'OSAMU GOODS Collaboration',
      'kaoyorinakami Collaboration', 'Suzuki Masaru Collaboration'
    ]),
    aliases: Object.freeze([
      alias('SmileSolar', /\bsmilesolar\b/i),
      alias('Superior', /\bsuperior\b/i),
      alias('SmileSolar', /\bsmile\s+solar\b/i),
      alias('Sports', /\bsports?\b/i),
      alias('Fashion', /\bfashion\b/i),
      alias('Digital', /\bdigital\b/i),
      alias('Elegant', /\belegant\b/i),
      alias('Ladies', /\bladies\b/i),
      alias('Series 003', /\bseries\s*003\b/i),
      alias('Series 004', /\bseries\s*004\b/i),
      alias('Matching Style Series 002', /\bmatching\s+style\s+series\s*002\b/i),
      alias('Mini Series', /\bmini\s+series\b/i),
      alias('20BAR Series', /\b20\s*bar\s+series\b/i),
      alias('STAR WARS Collection', /\bstar\s+wars\s+collection\b/i),
      alias('Peanuts Collection', /\bpeanuts\s+collection\b/i),
      alias('Disney Collection', /\bdisney\s+collection\b/i),
      alias('Champion Collection', /\bchampion\s+collection\b/i),
      alias('CAPTAIN STAG Collaboration', /\bcaptain\s+stag\s+collaboration\b/i),
      alias('PAPIER TIGRE Collaboration', /\bpapier\s+tigre\s+collaboration\b/i),
      alias('Q&Q SmileSolar BY groovisions', /\bq\s*&\s*q\s+smilesolar\s+by\s+groovisions\b/i),
      alias('THE PARK SHOP Collaboration', /\bthe\s+park\s+shop\s+collaboration\b/i),
      alias('OSAMU GOODS Collaboration', /\bosamu\s+goods\s+collaboration\b/i),
      alias('kaoyorinakami Collaboration', /\bkaoyorinakami\s+collaboration\b/i),
      alias('Suzuki Masaru Collaboration', /\bsuzuki\s+masaru\s+collaboration\b/i)
    ])
  }),
  seiko: Object.freeze({
    displayName: 'Seiko',
    promptPath: 'prompts/brands/seiko.txt',
    fallbackSeries: null,
    series: Object.freeze([
      'Prospex', 'Prospex Alpinist', 'Prospex Speedtimer', 'Prospex Diver Scuba',
      'Prospex Marinemaster', 'Presage', 'Presage Classic Series', 'Presage Cocktail Time',
      "Presage Style60's", 'Presage Inspired by Japanese Gardens', 'Presage Sharp Edged Series',
      'Astron', 'Astron GPS Solar', '5 Sports', '5 Sports SKX', '5 Sports Field', '5 Sports SNXS',
      'King Seiko', 'King Seiko KSK', 'King Seiko VANAC', 'King Seiko KS1969', 'Premier',
      'Coutura', 'Lukia', 'Alpinist', 'Recraft', 'Selection', 'Spirit'
    ]),
    aliases: Object.freeze([
      alias('King Seiko', /\bking\s+seiko\b/i),
      alias('5 Sports', /\b5\s+sports\b/i),
      alias('Prospex', /\bprospex\b/i),
      alias('Presage', /\bpresage\b/i),
      alias('Astron', /\bastron\b/i),
      alias('Premier', /\bpremier\b/i),
      alias('Coutura', /\bcoutura\b/i),
      alias('Lukia', /\blukia\b/i),
      alias('Alpinist', /\balpinist\b/i),
      alias('Prospex Speedtimer', /\bspeedtimer\b/i),
      alias('Prospex Marinemaster', /\bmarinemaster\b/i),
      alias('Prospex Diver Scuba', /\bdiver\s+scuba\b/i),
      alias('Presage Cocktail Time', /\bcocktail\s+time\b/i),
      alias("Presage Style60's", /\bstyle\s*60(?:'s|s)?\b/i),
      alias('Presage Sharp Edged Series', /\bsharp\s+edged\s+series\b/i),
      alias('5 Sports SKX', /\b5\s+sports\s+skx\b/i),
      alias('5 Sports Field', /\b5\s+sports\s+field\b/i),
      alias('5 Sports SNXS', /\b5\s+sports\s+snxs\b/i),
      alias('King Seiko KSK', /\bking\s+seiko\s+ksk\b/i),
      alias('King Seiko VANAC', /\bking\s+seiko\s+vanac\b/i),
      alias('King Seiko KS1969', /\bking\s+seiko\s+ks\s*1969\b/i),
      alias('Recraft', /\brecraft\b/i),
      alias('Selection', /\bselection\b/i),
      alias('Spirit', /\bspirit\b/i)
    ])
  }),
  citizen: Object.freeze({
    displayName: 'Citizen',
    promptPath: 'prompts/brands/citizen.txt',
    fallbackSeries: null,
    series: Object.freeze([
      'Eco-Drive', 'Eco-Drive One', 'Promaster', 'Promaster Marine', 'Promaster Sky',
      'Promaster Land', 'Tsuyosa', 'Series8', 'Series8 831', 'Series8 870', 'Series8 880 GMT',
      'Series8 890', 'The Citizen', 'Attesa', 'Satellite Wave', 'Super Titanium', 'Citizen L',
      'Corso', 'Calendrier', 'PCAT', 'Silhouette Crystal'
    ]),
    aliases: Object.freeze([
      alias('Satellite Wave', /\bsatellite\s+wave\b/i),
      alias('Eco-Drive', /\beco[-\s]?drive\b/i),
      alias('Promaster', /\bpromaster\b/i),
      alias('Tsuyosa', /\btsuyosa\b/i),
      alias('Series8', /\bseries\s*8\b/i),
      alias('The Citizen', /\bthe\s+citizen\b/i),
      alias('Attesa', /\battesa\b/i),
      alias('Eco-Drive One', /\beco[-\s]?drive\s+one\b/i),
      alias('Promaster Marine', /\bpromaster\s+marine\b/i),
      alias('Promaster Sky', /\bpromaster\s+sky\b/i),
      alias('Promaster Land', /\bpromaster\s+land\b/i),
      alias('Series8 831', /\bseries\s*8\s+831\b/i),
      alias('Series8 870', /\bseries\s*8\s+870\b/i),
      alias('Series8 880 GMT', /\bseries\s*8\s+880\s+gmt\b/i),
      alias('Series8 890', /\bseries\s*8\s+890\b/i),
      alias('Super Titanium', /\bsuper\s+titanium\b/i),
      alias('Citizen L', /\bcitizen\s+l\b/i),
      alias('Corso', /\bcorso\b/i),
      alias('Calendrier', /\bcalendrier\b/i),
      alias('PCAT', /\bpcat\b/i),
      alias('Silhouette Crystal', /\bsilhouette\s+crystal\b/i)
    ])
  }),
  longines: Object.freeze({
    displayName: 'Longines',
    promptPath: 'prompts/brands/longines.txt',
    fallbackSeries: null,
    series: Object.freeze([
      'Master Collection', 'Master Collection GMT', 'Master Collection Chronograph',
      'Master Collection Moonphase', 'HydroConquest', 'HydroConquest GMT', 'Spirit',
      'Spirit Zulu Time', 'Spirit Flyback', 'Spirit Chronograph', 'Conquest', 'Conquest Classic',
      'Conquest Chronograph', 'Conquest Heritage', 'Flagship', 'Flagship Classic',
      'Flagship Heritage', 'DolceVita', 'Mini DolceVita', 'La Grande Classique', 'Présence',
      'Record', 'Legend Diver', 'Ultra-Chron', 'Pilot Majetek', 'Heritage Classic',
      'Heritage Military', 'Evidenza', 'PrimaLuna', 'Elegant Collection', 'Avigation',
      'Lindbergh Hour Angle'
    ]),
    aliases: Object.freeze([
      alias('La Grande Classique', /\bla\s+grande\s+classique\b/i),
      alias('Master Collection', /\bmaster\s+collection\b/i),
      alias('HydroConquest', /\bhydro[-\s]?conquest\b/i),
      alias('DolceVita', /\bdolce[-\s]?vita\b/i),
      alias('Legend Diver', /\blegend\s+diver\b/i),
      alias('PrimaLuna', /\bprimaluna\b/i),
      alias('Evidenza', /\bevidenza\b/i),
      alias('Flagship', /\bflagship\b/i),
      alias('Conquest', /\bconquest\b/i),
      alias('Spirit', /\bspirit\b/i),
      alias('Présence', /\bpresence\b/i),
      alias('Record', /\brecord\b/i),
      alias('Master Collection GMT', /\bmaster\s+collection\s+gmt\b/i),
      alias('Master Collection Chronograph', /\bmaster\s+collection\s+chronograph\b/i),
      alias('Master Collection Moonphase', /\bmaster\s+collection\s+moonphase\b/i),
      alias('HydroConquest GMT', /\bhydro[-\s]?conquest\s+gmt\b/i),
      alias('Spirit Zulu Time', /\bspirit\s+zulu\s+time\b/i),
      alias('Spirit Flyback', /\bspirit\s+flyback\b/i),
      alias('Spirit Chronograph', /\bspirit\s+chronograph\b/i),
      alias('Conquest Heritage', /\bconquest\s+heritage\b/i),
      alias('Conquest Classic', /\bconquest\s+classic\b/i),
      alias('Conquest Chronograph', /\bconquest\s+chronograph\b/i),
      alias('Flagship Classic', /\bflagship\s+classic\b/i),
      alias('Flagship Heritage', /\bflagship\s+heritage\b/i),
      alias('Mini DolceVita', /\bmini\s+dolce[-\s]?vita\b/i),
      alias('Ultra-Chron', /\bultra[-\s]?chron\b/i),
      alias('Pilot Majetek', /\bpilot\s+majetek\b/i),
      alias('Heritage Classic', /\bheritage\s+classic\b/i),
      alias('Heritage Military', /\bheritage\s+military\b/i),
      alias('Elegant Collection', /\belegant\s+collection\b/i),
      alias('Avigation', /\bavigation\b/i),
      alias('Lindbergh Hour Angle', /\blindbergh\s+hour\s+angle\b/i)
    ])
  }),
  diesel: Object.freeze({
    displayName: 'Diesel',
    promptPath: 'prompts/brands/diesel.txt',
    fallbackSeries: null,
    series: Object.freeze([
      'Mega Chief', 'Mr. Daddy', 'Griffed', 'Overflow', 'Double Down', 'Rasp',
      'Little Daddy', 'Mini Daddy', 'Scraper', 'Stinger', 'Spiked', 'Mercurial', 'Vert',
      'Closer', 'D-Era', 'D-Curve', 'Streamline', 'Framed', 'Armbar', 'Metamorph'
    ]),
    aliases: Object.freeze([
      alias('Mega Chief', /\bmega\s+chief\b/i),
      alias('Mr. Daddy', /\bmr\.?\s+daddy\b/i),
      alias('Little Daddy', /\blittle\s+daddy\b/i),
      alias('Mini Daddy', /\bmini\s+daddy\b/i),
      alias('Double Down', /\bdouble\s+down\b/i),
      alias('Griffed', /\bgriffed\b/i),
      alias('Overflow', /\boverflow\b/i),
      alias('Scraper', /\bscraper\b/i),
      alias('Rasp', /\brasp\b/i),
      alias('Stinger', /\bstinger\b/i),
      alias('Spiked', /\bspiked\b/i),
      alias('Mercurial', /\bmercurial\b/i),
      alias('Vert', /\bvert\b/i),
      alias('Closer', /\bcloser\b/i),
      alias('D-Era', /\bd[-\s]?era\b/i),
      alias('D-Curve', /\bd[-\s]?curve\b/i),
      alias('Streamline', /\bstreamline\b/i),
      alias('Framed', /\bframed\b/i),
      alias('Armbar', /\barmbar\b/i),
      alias('Metamorph', /\bmetamorph\b/i)
    ])
  }),
  armani_exchange: Object.freeze({
    displayName: 'Armani Exchange',
    promptPath: 'prompts/brands/armani-exchange.txt',
    fallbackSeries: null,
    series: Object.freeze(['A|X Sync', 'A|X Bass', 'A|X Audora', 'Digital', 'Hampton', 'Drexler', 'Hugo', 'Outerbanks', 'AX Chronograph']),
    aliases: Object.freeze([
      alias('AX Chronograph', /\bax\s+chronograph\b/i),
      alias('Outerbanks', /\bouterbanks\b/i),
      alias('Hampton', /\bhampton\b/i),
      alias('Drexler', /\bdrexler\b/i),
      alias('Hugo', /\bhugo\b/i),
      alias('A|X Sync', /\ba\s*[|/]?\s*x\s+sync\b|\bsync\b/i),
      alias('A|X Bass', /\ba\s*[|/]?\s*x\s+bass\b/i),
      alias('A|X Audora', /\ba\s*[|/]?\s*x\s+audora\b|\baudora\b/i),
      alias('Digital', /\bdigital\s+watch\b/i)
    ])
  }),
  certina: Object.freeze({
    displayName: 'Certina',
    promptPath: 'prompts/brands/certina.txt',
    fallbackSeries: null,
    series: Object.freeze(['DS+', 'DS-1', 'DS-2', 'DS-6', 'DS-7', 'DS-8', 'DS Action', 'DS PH', 'DS Caimano', 'DS Jubile', 'DS', 'DS Podium', 'DS-X']),
    aliases: Object.freeze([
      alias('DS Action', /\bds[-\s]?action\b/i),
      alias('DS Podium', /\bds[-\s]?podium\b/i),
      alias('DS Caimano', /\bds[-\s]?caimano\b/i),
      alias('DS PH', /\bds[-\s]?ph\b/i),
      alias('DS-1', /\bds[-\s]?1\b/i),
      alias('DS-2', /\bds[-\s]?2\b/i),
      alias('DS-6', /\bds[-\s]?6\b/i),
      alias('DS-7', /\bds[-\s]?7\b/i),
      alias('DS-8', /\bds[-\s]?8\b/i),
      alias('DS+', /\bds\s*\+\b/i),
      alias('DS Jubile', /\bds\s+jubile\b/i),
      alias('DS-X', /\bds[-\s]?x\b/i),
      alias('DS', /\bds\b/i)
    ])
  }),
  generic: Object.freeze({
    displayName: 'Общий профиль',
    promptPath: 'prompts/brands/generic.txt',
    fallbackSeries: null,
    series: Object.freeze([]),
    aliases: Object.freeze([])
  })
});

// The bundled brand files contain the closed vocabulary and source hints. This
// small map keeps only genuinely brand-specific exceptions, so the runtime
// prompt does not repeat the same layout and evidence rules for every brand.
const BRAND_SPECIAL_RULES = Object.freeze({
  benyar: Object.freeze([
    'В названии бренда используй только точное слово BENYAR; новый логотип или монограмму не создавай.',
    'Automatic, Explorer, Professional Divers, Ladies, Sport и голое Chronograph не являются серией по внешнему виду или догадке.',
    'Для BY-5163, BY-5177 и BY-5208 код является поисковым ключом; при отсутствии подтверждённой серии используй режим без серии с Benyar во второй строке.'
  ]),
  casio: Object.freeze([
    'Сохрани точное написание CASIO из главного шаблона; верхний логотип уже готов и не перерисовывается.',
    'В строке 1 выводи только Casio, во второй — только токен серии. Для VINTAGE и COLLECTION запрещено повторять Casio во второй строке.',
    'Fallback «Classic» разрешён только обычной неименованной модели Casio после завершения поиска и только по правилам профиля.',
    'Sports, Professional, Quartz, Digital и Automatic не назначай серией без прямого подтверждения из словаря.'
  ]),
  generic: Object.freeze([
    'У общего профиля нет разрешённых серий: при отсутствии совпадения оставь первую строку пустой, бренд перенеси на позицию второй строки.',
    'Логотип бренда шапки уже находится в главном шаблоне и не заменяется отдельным логотипом магазина.'
  ])
});

const SERIES_DISPLAY_OVERRIDES = Object.freeze({
  casio: Object.freeze({
    VINTAGE: 'Vintage',
    COLLECTION: 'Collection',
    CASIOTRON: 'Casiotron'
  })
});

function printableSeriesName(profile, series) {
  if (!series) return null;
  return SERIES_DISPLAY_OVERRIDES[profile]?.[series] || series;
}

function brandLabelForTitle(profile, modelName) {
  const metadata = getBrandProfile(profile);
  if (metadata.displayName !== 'Общий профиль') return metadata.displayName;
  const normalized = normalizeModelName(modelName)
    .replace(/\.(?:png|jpe?g|webp|bmp|gif|tiff?)$/i, '')
    .trim();
  const code = extractReferenceCode(normalized);
  if (!code) return normalized.split(/\s+/).slice(0, 2).join(' ') || 'Бренд';
  const index = matchingModelName(normalized).toUpperCase().indexOf(code.toUpperCase());
  const rawPrefix = index > 0 ? normalized.slice(0, index).trim() : normalized;
  return rawPrefix
    .replace(/[,;:–—-]+$/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(' ') || 'Бренд';
}

export function resolveTitleSpec(modelName) {
  const normalizedModelName = normalizeModelName(modelName);
  const profile = detectBrandProfile(normalizedModelName);
  const metadata = getBrandProfile(profile);
  const referenceCode = extractReferenceCode(normalizedModelName);
  if (profile === 'pagani_design') {
    return Object.freeze({
      profile,
      brand: 'Pagani Design',
      referenceCode,
      explicitSeries: null,
      explicitSeriesPrint: null,
      fallbackSeries: null,
      seriesRequired: true,
      fixedLines: Object.freeze(['Pagani', 'Design', referenceCode || 'полный код PD-модели']),
      mode: 'fixed'
    });
  }
  const explicitSeries = resolveExplicitBrandSeries(normalizedModelName);
  const explicitSeriesPrint = printableSeriesName(profile, explicitSeries);
  const fallbackSeries = metadata.fallbackSeries || null;
  return Object.freeze({
    profile,
    brand: brandLabelForTitle(profile, normalizedModelName),
    referenceCode,
    explicitSeries,
    explicitSeriesPrint,
    fallbackSeries,
    seriesRequired: metadata.seriesRequired === true,
    fixedLines: null,
    mode: explicitSeries ? 'candidate' : 'search'
  });
}

export function buildTitleContract(modelName, options = {}) {
  const spec = resolveTitleSpec(modelName);
  const inputPlan = options?.inputPlan || buildInputPlan(options?.inputMode);
  const templateRef = inputPlan.refs.template || 'главный шаблон';
  const code = spec.referenceCode || 'полный технический код из исходного названия';
  if (spec.mode === 'fixed') {
    return [
      'TITLE CONTRACT — ОБЯЗАТЕЛЬНЫЙ ФИНАЛЬНЫЙ БЛОК НАЗВАНИЯ',
      'Этот контракт имеет приоритет над общими формулировками о заголовке. Это не рекомендация, а фиксированная разметка.',
      `Строка 1: «${spec.fixedLines[0]}»`,
      `Строка 2: «${spec.fixedLines[1]}»`,
      `Строка 3: модель «${spec.fixedLines[2]}» меньшим кеглем, чем строки 1 и 2.`,
      'Не добавляй серии. Не объединяй брендовые строки и не удаляй строку 2. Если не хватает места, уменьши кегль модели, сохранив три отдельные строки.',
      `Сохрани позиции, межстрочный ритм и ширину блока из ${templateRef}. Отсутствующая или объединённая строка считается ошибкой результата.`
    ].join('\n');
  }

  const lines = [
    'TITLE CONTRACT — ОБЯЗАТЕЛЬНАЯ СПЕЦИФИКАЦИЯ БЛОКА НАЗВАНИЯ',
    'Этот контракт идёт последним и имеет приоритет над общими формулировками о заголовке. Перед вызовом генерации изображения выбери допустимый для этого бренда режим ниже и зафиксируй его.',
    `Бренд: «${spec.brand}».`,
    `Технический код: «${code}».`
  ];

  if (spec.explicitSeriesPrint) {
    lines.push(
      `В исходном названии есть разрешённый словарём кандидат серии: «${spec.explicitSeriesPrint}». Он является сильной подсказкой, но всё равно проверь точный артикул по правилам профиля бренда.`,
      `Если источник подтверждает этот кандидат и не даёт более точной разрешённой подсерии, SERIES MODE обязан быть ровно таким:
Строка 1: «${spec.brand}»
Строка 2: «${spec.explicitSeriesPrint}»
Строка 3: «${code}»`,
      'После подтверждения серии строка 2 ОБЯЗАТЕЛЬНА. Запрещено молча перейти к двухстрочному варианту, убрать серию или слить бренд с серией.',
      'Если официальный источник прямо связывает с этим же кодом другую, более точную серию из закрытого словаря, используй её каноническое печатное имя во второй строке вместо кандидата.'
    );
  } else {
    lines.push(
      'В исходном названии нет отдельного разрешённого кандидата серии. Выполни поиск по точному бренду и коду только внутри закрытого словаря профиля.',
      `Если подтверждена серия из словаря, SERIES MODE обязан быть ровно таким:
Строка 1: «${spec.brand}»
Строка 2: «<подтверждённая каноническая серия>»
Строка 3: «${code}»`
    );
  }

  if (spec.fallbackSeries) {
    lines.push(`Если прямое название серии не найдено, fallback «${printableSeriesName(spec.profile, spec.fallbackSeries)}» разрешён только при выполнении специальных условий профиля бренда. Он не включается автоматически.`);
  }

  if (spec.seriesRequired) {
    lines.push(
      'ДЛЯ ЭТОГО БРЕНДА СЕРИЯ ОБЯЗАТЕЛЬНА: NO-SERIES MODE запрещён. Не вызывай генерацию изображения, пока не выбрана подтверждённая серия из закрытого словаря или допустимый fallback по правилам профиля.',
      `Финальный title block всегда содержит три видимые строки:
Строка 1: «${spec.brand}»
Строка 2: «<подтверждённая каноническая серия>»
Строка 3: «${code}»`,
      'После выбора серии не меняй структуру во время рендера. Количество строк, их порядок и текст становятся фиксированными.'
    );
  } else {
    lines.push(
      `Если серия не подтверждена и fallback неприменим, NO-SERIES MODE обязан быть ровно таким:
Строка 1: <пустая фиксированная строка>
Строка 2: «${spec.brand}»
Строка 3: «${code}»`,
      'После выбора SERIES MODE или NO-SERIES MODE не меняй структуру во время рендера. Количество строк, их порядок и текст становятся фиксированными.'
    );
  }

  lines.push(
    'КРИТИЧЕСКОЕ ПРАВИЛО: в SERIES MODE вторая строка не может исчезнуть. Не объединяй строки 1 и 2. Не заменяй три строки двумя. При нехватке места сначала уменьши кегль/трекинг в пределах стиля шаблона, но сохрани все обязательные строки.',
    `Перед финальной выдачей сравни title block с выбранным режимом посимвольно. Если обязательная строка отсутствует, объединена или заменена — исправь карточку до выдачи. Сохрани геометрию блока из ${templateRef}.`
  );
  return lines.join('\n');
}

function buildPaganiBrandInstruction(modelName, options = {}) {
  const inputPlan = options?.inputPlan || buildInputPlan(options?.inputMode);
  const templateRef = inputPlan.refs.template || 'главный шаблон';
  const referenceCode = extractReferenceCode(modelName);
  const codeLabel = referenceCode ? `«${referenceCode}»` : 'из исходного названия модели';
  return [
    'ПРОФИЛЬ БРЕНДА PAGANI DESIGN — ФИКСИРОВАННАЯ РАЗМЕТКА',
    `— Бренд этой генерации: Pagani Design. Брендовый знак шапки уже зафиксирован в ${templateRef} и сохраняется без перерисовки.`,
    '— Блок названия состоит из двух брендовых строк и строки модели меньшим кеглем:',
    '  1) «Pagani»; 2) «Design»; 3) название модели с полным техническим кодом.',
    `— Для этой модели технический код: ${codeLabel}. Выведи его один раз в третьей строке, без сокращений и дублей; строку модели сделай заметно меньше двух брендовых строк.`,
    '— Серии для Pagani Design не используются. Между «Design» и моделью серию не вставляй. После строки модели ничего не добавляй: категории, механизмы, назначение и homage-модели исключены из блока названия.',
    `— Сохрани межстрочный ритм, позицию и композицию текстового блока из ${templateRef}; визуальную иерархию соблюдай: Pagani / Design крупно, модель меньшим кеглем.`
  ].join('\n');
}

export function brandProfileIds() {
  return Object.keys(BRAND_PROFILE_META);
}

export function getBrandProfile(profileId) {
  return BRAND_PROFILE_META[String(profileId || '').trim()] || BRAND_PROFILE_META.generic;
}

export function detectBrandProfile(modelName) {
  const value = matchingModelName(modelName).toLowerCase();
  if (/\bpagani\s+design\b/.test(value)) return 'pagani_design';
  if (/\barmani\s+exchange\b/.test(value)) return 'armani_exchange';
  if (/\bbenyar\b/.test(value)) return 'benyar';
  if (/\bcasio\b/.test(value)) return 'casio';
  if (/\borient\b/.test(value)) return 'orient';
  if (/\btissot\b/.test(value)) return 'tissot';
  if (/\bq\s*&\s*q\b/.test(value)) return 'q_and_q';
  if (/\bseiko\b/.test(value)) return 'seiko';
  if (/\bcitizen\b/.test(value)) return 'citizen';
  if (/\blongines\b/.test(value)) return 'longines';
  if (/\bdiesel\b/.test(value)) return 'diesel';
  if (/\bcertina\b/.test(value)) return 'certina';
  return 'generic';
}

function resolveAllowedSeriesAlias(modelName) {
  const profile = detectBrandProfile(modelName);
  const metadata = getBrandProfile(profile);
  const value = matchingModelName(modelName);
  return (metadata.aliases || [])
    .filter((item) => metadata.series.includes(item.name) && item.pattern.test(value))
    .sort((left, right) => right.name.length - left.name.length)[0]?.name || null;
}

export function resolveBrandSeries(modelName) {
  const profile = detectBrandProfile(modelName);
  return resolveAllowedSeriesAlias(modelName) || getBrandProfile(profile).fallbackSeries || null;
}

function resolveExplicitBrandSeries(modelName) {
  return resolveAllowedSeriesAlias(modelName);
}

export function brandPromptPath(profileOrModelName) {
  const value = String(profileOrModelName || '').trim();
  const profile = Object.hasOwn(BRAND_PROFILE_META, value) ? value : detectBrandProfile(value);
  return getBrandProfile(profile).promptPath;
}

export function extractReferenceCode(modelName) {
  const value = normalizeModelName(modelName)
    .replace(/\.(?:png|jpe?g|webp|bmp|gif|tiff?)$/i, '')
    .trim();
  const matches = WATCH_REFERENCE_PATTERNS.flatMap((pattern) => (
    [...value.matchAll(pattern)].map((match) => ({ index: match.index ?? 0, raw: String(match[1] || '').trim() }))
  )).sort((left, right) => left.index - right.index || left.raw.length - right.raw.length);
  for (const { raw } of matches) {
    const rawParts = raw.split(/\s+/);
    const codeParts = [];
    for (const [index, part] of rawParts.entries()) {
      // Spaces inside a code are accepted while the following segment still
      // carries a digit (for example: GA 2100 1A1). Plain words such as
      // "Automatic" are title descriptors and terminate the code.
      if (index > 0 && !/\d/.test(part)) break;
      codeParts.push(part);
    }
    const candidate = codeParts.join('-').replace(/\s+/g, '-').toUpperCase();
    if (!candidate || REFERENCE_NON_CODES.some((pattern) => pattern.test(candidate))) continue;
    const segments = candidate.split('-').filter(Boolean);
    const firstSegment = segments[0] || '';
    const digitCount = (candidate.match(/\d/g) || []).length;
    if (digitCount < 2 || REFERENCE_BRAND_PREFIXES.has(firstSegment)) continue;
    // A technical code either carries a digit in its first segment (T126...,
    // AX1721) or starts with a short code prefix followed by a digit-bearing
    // segment (BY-S001..., GA-2100...). This filters lexical series names
    // while retaining legitimate one-letter prefixes such as G-5600.
    if (!/\d/.test(firstSegment)) {
      const secondSegment = segments[1] || '';
      if (firstSegment.length > 3 || !/\d/.test(secondSegment)) continue;
      if (REFERENCE_PREFIX_STOPWORDS.has(firstSegment)) continue;
    }
    return candidate;
  }
  return null;
}

export function buildBrandInstruction(modelName, options = {}) {
  const profile = detectBrandProfile(modelName);
  const inputPlan = options?.inputPlan || buildInputPlan(options?.inputMode);
  const templateRef = inputPlan.refs.template || 'главный шаблон';
  if (profile === 'pagani_design') return buildPaganiBrandInstruction(modelName, { ...options, inputPlan });
  const normalizedModelName = normalizeModelName(modelName);
  const referenceCode = extractReferenceCode(modelName);
  const metadata = getBrandProfile(profile);
  const explicitSeries = resolveExplicitBrandSeries(modelName);
  const fallbackSeries = metadata.fallbackSeries || null;
  const searchTarget = referenceCode
    ? `${metadata.displayName} ${referenceCode}`
    : normalizedModelName || `${metadata.displayName} полное название модели`;
  const lines = [
    `ПРОФИЛЬ БРЕНДА ${metadata.displayName.toUpperCase()} — RUNTIME-КОНТРОЛЬ`,
    `— Бренд этой генерации: ${metadata.displayName === 'Общий профиль' ? 'точное название бренда из исходного названия' : `«${metadata.displayName}»`}. Логотип шапки уже зафиксирован в ${templateRef}.`,
    `— Технический код: ${referenceCode ? `«${referenceCode}»` : 'из исходного названия'}. Код не является серией и печатается только один раз в технической строке.`,
    explicitSeries
      ? `— В исходном названии обнаружен разрешённый кандидат серии «${printableSeriesName(profile, explicitSeries)}». Проверь его по точному артикулу; не отбрасывай этот кандидат без причины и не считай имя файла единственным доказательством.`
      : '— В исходном названии отдельный разрешённый кандидат серии не обнаружен. Ищи серию по точному артикулу только внутри закрытого словаря из файла профиля.',
    `— Поисковый ключ: «${searchTarget}». Приоритет: официальная карточка модели, официальный каталог и инструкция; продавец — только дополнительное подтверждение.`,
    '— Интернет не расширяет локальный словарь. Используй только каноническое значение, разрешённое файлом профиля бренда.',
    '— Решение о строках заголовка не принимай свободно: после этого блока будет TITLE CONTRACT, который задаёт обязательные режимы и финальную разметку.'
  ];
  if (fallbackSeries) {
    lines.push(`— Fallback «${printableSeriesName(profile, fallbackSeries)}» применим только при выполнении условий файла профиля; отсутствие результата поиска само по себе не включает fallback.`);
  } else {
    lines.push('— Fallback отсутствует: без подтверждённой серии используй только NO-SERIES MODE из TITLE CONTRACT.');
  }
  lines.push(...(BRAND_SPECIAL_RULES[profile] || []));
  return lines.join('\n').trim();
}

function stripSeriesSection(promptText) {
  const text = String(promptText || '');
  const start = text.search(/^ПОИСК МОДЕЛИ И СЕРИИ\s*$/im);
  const end = text.search(/^ПРОВЕРКА ФАКТОВ И УТП\s*$/im);
  if (start < 0 || end < 0 || end <= start) return text;
  return `${text.slice(0, start).trim()}\n\n${text.slice(end).trim()}`
    .replace(/названию бренда или серии/gi, 'названию бренда')
    .replace(
      '4. Заголовок следует правилу подтверждённой серии или режиму без серии; полный код написан один раз.',
      '4. Заголовок содержит две строки «Pagani» и «Design», полный код написан один раз.'
    );
}

export function buildGenerationPrompt(basePrompt, modelName, brandPrompt = '', options = {}) {
  const normalizedModelName = normalizeModelName(modelName);
  const profile = detectBrandProfile(normalizedModelName);
  const inputPlan = options?.inputPlan || buildInputPlan(options?.inputMode);
  let prompt = profile === 'pagani_design'
    ? stripSeriesSection(basePrompt)
    : String(basePrompt || '');
  for (const placeholder of MODEL_PLACEHOLDERS) {
    prompt = prompt.replaceAll(placeholder, normalizedModelName);
  }
  prompt = renderReferenceAwareText(prompt, inputPlan);
  const sections = [prompt.trim()];
  const profileText = renderReferenceAwareText(String(brandPrompt || '').trim(), inputPlan);
  if (profileText) {
    sections.push(`ФАЙЛ ПРОФИЛЯ БРЕНДА — ИСПОЛЬЗУЙ КАК ИСТОЧНИК ПРАВИЛ:
${profileText}`);
  }
  const brandInstruction = buildBrandInstruction(normalizedModelName, { inputPlan });
  sections.push(`КОНТРОЛЬ БРЕНДА И ПРОВЕРКИ:
${renderReferenceAwareText(brandInstruction, inputPlan)}`);
  sections.push(renderReferenceAwareText(buildTitleContract(normalizedModelName, { inputPlan }), inputPlan));
  return sections.filter(Boolean).join('\n\n').trim();
}
