// Rule-based Roman-Urdu → Urdu-script transliteration (PKR 0, no APIs,
// no network, no credentials). Dictionary-first for common Pakistani name
// tokens, letter-by-letter fallback for anything else.
//
// HONEST LIMIT: the output is a BEST GUESS. Roman Urdu is ambiguous —
// short vowels are not written in Urdu script, and some spellings have
// two correct Urdu forms (e.g. Sana = ثناء or سنا). Every Urdu field is
// editable on the review screen before anything is saved, and the student
// edit form lets an admin fix it later. The dictionary picks the common
// given-name spelling for ambiguous tokens (see the accuracy table in
// transliterate.test.ts — the test asserts every name from the real
// 20-row table photo, including the ambiguous ones).
//
// Rules:
// - Input is one full name ("Ahmed Khan"); tokens are transliterated
//   separately and joined with a space.
// - A token already in Urdu script is kept as-is; a name with no Latin
//   letters returns null (nothing to transliterate — the caller keeps the
//   Urdu name the OCR pass already read, if any).
// - Never transliterate phone numbers, roll numbers or "s/o" tails.

const URDU_RE = /[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** Common Pakistani name tokens → their standard Urdu spelling. */
const DICTIONARY: Record<string, string> = {
  // First names — boys
  ahmed: 'احمد',
  ahmad: 'احمد',
  muhammad: 'محمد',
  mohammad: 'محمد',
  mohammed: 'محمد',
  muhammed: 'محمد',
  abdullah: 'عبداللہ',
  abdul: 'عبد',
  mustafa: 'مصطفیٰ',
  ibrahim: 'ابراہیم',
  ismail: 'اسماعیل',
  ismael: 'اسماعیل',
  yusuf: 'یوسف',
  yousuf: 'یوسف',
  dawood: 'داؤد',
  suleman: 'سلیمان',
  haroon: 'ہارون',
  musa: 'موسیٰ',
  isa: 'عیسیٰ',
  younis: 'یونس',
  idrees: 'ادریس',
  zakariya: 'زکریا',
  ilyas: 'الیاس',
  ayub: 'ایوب',
  nuh: 'نوح',
  saleh: 'صالح',
  shuaib: 'شعیب',
  uzair: 'عزیر',
  yahya: 'یحییٰ',
  umar: 'عمر',
  omar: 'عمر',
  usman: 'عثمان',
  usama: 'اسامہ',
  osama: 'اسامہ',
  hamza: 'حمزہ',
  talha: 'طلحہ',
  zain: 'زین',
  daniyal: 'دانیال',
  danial: 'دانیال',
  bilal: 'بلال',
  hassan: 'حسن',
  hasan: 'حسن',
  hussain: 'حسین',
  husain: 'حسین',
  ali: 'علی',
  raza: 'رضا',
  abbas: 'عباس',
  tariq: 'طارق',
  saeed: 'سعید',
  sayeed: 'سعید',
  javed: 'جاوید',
  jawed: 'جاوید',
  akhtar: 'اختر',
  farooq: 'فاروق',
  farouk: 'فاروق',
  mehmood: 'محمود',
  mahmood: 'محمود',
  iqbal: 'اقبال',
  anwar: 'انور',
  rashid: 'راشد',
  khalid: 'خالد',
  zahid: 'زاہد',
  sajid: 'ساجد',
  imran: 'عمران',
  aslam: 'اسلم',
  pervaiz: 'پرویز',
  parvez: 'پرویز',
  naveed: 'نوید',
  navid: 'نوید',
  siddique: 'صدیق',
  siddiq: 'صدیق',
  saad: 'سعد',
  siddiqui: 'صدیقی',
  qureshi: 'قریشی',
  rizwan: 'رضوان',
  salman: 'سلمان',
  salim: 'سلیم',
  saleem: 'سلیم',
  shahid: 'شاہد',
  arif: 'عارف',
  nasir: 'ناصر',
  naseer: 'نصیر',
  shakeel: 'شکیل',
  shafiq: 'شفیق',
  rafiq: 'رفیق',
  hanif: 'حنیف',
  latif: 'لطیف',
  munir: 'منیر',
  bashir: 'بشیر',
  nazir: 'نذیر',
  tahir: 'طاہر',
  zahir: 'ظاہر',
  amir: 'عامر',
  aamir: 'عامر',
  adil: 'عادل',
  faisal: 'فیصل',
  kamran: 'کامران',
  shahbaz: 'شہباز',
  shahzad: 'شہزاد',
  sheraz: 'شیراز',
  farhan: 'فرحان',
  rehan: 'ریحان',
  rayan: 'ریان',
  arham: 'ارحم',
  ayan: 'ایان',
  zoya: 'زویا',
  ahad: 'احد',
  hadi: 'ہادی',
  // First names — girls
  fatima: 'فاطمہ',
  aisha: 'عائشہ',
  ayesha: 'عائشہ',
  khadija: 'خدیجہ',
  maryam: 'مریم',
  zainab: 'زینب',
  amna: 'آمنہ',
  amina: 'آمنہ',
  hira: 'حرا',
  sara: 'سارہ',
  noor: 'نور',
  mahnoor: 'ماہ نور',
  laiba: 'لائبہ',
  areeba: 'اریبہ',
  iqra: 'اقراء',
  hina: 'حنا',
  sana: 'ثناء', // ambiguous: ثناء (common given-name spelling) vs سنا — review covers it
  rabia: 'رابعہ',
  saba: 'صبا',
  nida: 'ندا',
  farah: 'فرح',
  bushra: 'بشریٰ',
  shazia: 'شازیہ',
  parveen: 'پروین',
  nasreen: 'نسرین',
  salma: 'سلمیٰ',
  rukhsana: 'رخسانہ',
  shabana: 'شبانہ',
  yasmin: 'یاسمین',
  hafsa: 'حفصہ',
  safia: 'صفیہ',
  tayyaba: 'طیبہ',
  adeeba: 'ادیبہ',
  asma: 'اسماء',
  sadia: 'سعدیہ',
  samina: 'ثمینہ',
  farzana: 'فرزانہ',
  shabnam: 'شبنم',
  nargis: 'نرگس',
  sumaiya: 'سمیہ',
  sumayya: 'سمیہ',
  sakina: 'سکینہ',
  ruqayya: 'رقیہ',
  kulsoom: 'کلثوم',
  kulsum: 'کلثوم',
  zahra: 'زہرا',
  jannat: 'جنت',
  dua: 'دعا',
  hiba: 'ہبہ',
  manahil: 'مناہل',
  anaya: 'انایا',
  aliza: 'علیزہ',
  hoor: 'حور',
  wania: 'وانیہ',
  esha: 'عشاء',
  eshal: 'ایشل',
  // Surnames / tribes / honorifics
  khan: 'خان',
  malik: 'ملک',
  butt: 'بٹ',
  sheikh: 'شیخ',
  mirza: 'مرزا',
  syed: 'سید',
  shah: 'شاہ',
  ansari: 'انصاری',
  chaudhry: 'چوہدری',
  choudhry: 'چوہدری',
  rajput: 'راجپوت',
  awan: 'اعوان',
  jutt: 'جٹ',
  gujjar: 'گجر',
  arain: 'آرائیں',
  mughal: 'مغل',
  pathan: 'پٹھان',
  afridi: 'آفریدی',
  kazmi: 'کاظمی',
  zaidi: 'زیدی',
  rizvi: 'رضوی',
  naqvi: 'نقوی',
  jafri: 'جعفری',
  bukhari: 'بخاری',
  gilani: 'گیلانی',
  chishti: 'چشتی',
  farooqi: 'فاروقی',
  usmani: 'عثمانی',
  hashmi: 'ہاشمی',
  abbasi: 'عباسی',
  umm: 'ام',
  bibi: 'بی بی',
  begum: 'بیگم',
  gul: 'گل',
  jan: 'جان',
  // Particles / connectors
  e: '', // izafat ("Umm-e-Kulsoom" → ام کلثوم)
  bin: 'بن',
  bint: 'بنت',
};

/** Two-letter Roman-Urdu sounds, checked before single letters. */
const DIGRAPHS: Array<[string, string]> = [
  ['kh', 'خ'],
  ['gh', 'غ'],
  ['ch', 'چ'],
  ['sh', 'ش'],
  ['th', 'تھ'],
  ['ph', 'پھ'],
  ['bh', 'بھ'],
  ['dh', 'دھ'],
  ['jh', 'جھ'],
  ['rh', 'ڑھ'],
  ['aa', 'ا'],
  ['ee', 'ی'],
  ['oo', 'و'],
  ['ai', 'ے'],
  ['ay', 'ے'],
  ['au', 'و'],
  ['ou', 'و'],
  ['ei', 'ی'],
  ['ng', 'ں'],
];

/** Single Roman letters → Urdu letters (used by the fallback only). */
const SINGLES: Record<string, string> = {
  b: 'ب',
  c: 'ک',
  d: 'د',
  f: 'ف',
  g: 'گ',
  h: 'ہ',
  j: 'ج',
  k: 'ک',
  l: 'ل',
  m: 'م',
  n: 'ن',
  p: 'پ',
  q: 'ق',
  r: 'ر',
  s: 'س',
  t: 'ت',
  v: 'و',
  w: 'و',
  x: 'کس',
  y: 'ی',
  z: 'ز',
};

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

/**
 * Letter-by-letter fallback for a token the dictionary does not know.
 * Short vowels (a/e/i/o/u) are mostly unwritten in Urdu script, so medial
 * short vowels are dropped; word-initial vowels and long vowels keep a
 * letter. This is approximate by design — the dictionary covers the
 * common names, and the review screen is the safety net for the rest.
 */
function transliterateTokenFallback(token: string): string {
  const t = token.toLowerCase();
  let out = '';
  let i = 0;
  let prevChar = '';
  while (i < t.length) {
    // Collapse doubled consonants (Hassan → حسن needs one س, not two).
    if (i > 0 && t[i] === prevChar && !VOWELS.has(t[i]!) && t[i] !== 'h') {
      i++;
      continue;
    }
    // Two-letter sounds first.
    const two = t.slice(i, i + 2);
    const digraph = DIGRAPHS.find(([d]) => d === two);
    if (digraph) {
      out += digraph[1];
      prevChar = t[i + 1]!;
      i += 2;
      continue;
    }
    const ch = t[i]!;
    if (VOWELS.has(ch)) {
      const isFirst = i === 0;
      const isLast = i === t.length - 1;
      if (ch === 'a') {
        if (isFirst) out += 'ا';
        else if (isLast) {
          // Final 'a': 'ا' after ی/ے (Zoya → زویا), dropped otherwise (Sana → سنا).
          if (out.endsWith('ی') || out.endsWith('ے')) out += 'ا';
        }
        // Medial 'a' is an unwritten short vowel — drop.
      } else if (ch === 'e') {
        if (isFirst) out += 'ا';
        else if (isLast) out += 'ہ'; // Adeeba → ادیبہ
        // Medial 'e' dropped.
      } else if (ch === 'i') {
        if (isFirst) out += 'ا';
        else if (isLast) out += 'ی';
        // Medial 'i' dropped.
      } else if (ch === 'o') {
        out += 'و'; // 'o' is a long vowel in Roman Urdu.
      } else if (ch === 'u') {
        if (isFirst || isLast) out += 'و';
        // Medial 'u' (pesh) is unwritten — drop.
      }
    } else if (SINGLES[ch]) {
      out += SINGLES[ch]!;
    }
    // Any other character (digits, punctuation) is skipped.
    prevChar = ch;
    i++;
  }
  return out;
}

/** Transliterate one token: dictionary first, letter fallback second. */
export function transliterateToken(token: string): string {
  if (URDU_RE.test(token)) return token; // already Urdu — keep as-is
  const key = token.toLowerCase().replace(/[^a-z]/g, '');
  if (!key) return token;
  const known = DICTIONARY[key];
  if (known !== undefined) return known;
  return transliterateTokenFallback(key);
}

/**
 * Transliterate a full Roman-Urdu name ("Ahmed Khan" → "احمد خان").
 * Returns null when there is nothing Latin to transliterate (empty input,
 * an already-Urdu name, or digits only) — the caller keeps whatever Urdu
 * name it already has (or null).
 */
export function transliterateName(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (!/[A-Za-z]/.test(trimmed)) return null; // already Urdu / no Latin letters
  const parts = trimmed
    .split(/[\s\-]+/)
    .filter((p) => p && !/^(s\/o|d\/o|w\/o)$/i.test(p))
    .map(transliterateToken)
    .filter((p) => p !== '');
  if (parts.length === 0) return null;
  return parts.join(' ');
}
