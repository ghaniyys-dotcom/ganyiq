/**
 * Candidate Extraction V2 — Deterministic pre-filter before LLM stage.
 *
 * INPUT:  TranscriptSegment[] (e.g., 747 segments)
 * OUTPUT: CandidateWindow[] (20-35 candidates, sorted by score descending)
 *
 * DESIGN LOCKED — Do not modify signal definitions without validation.
 *
 * Architecture:
 *   1. Score each segment against 15 text signals (keyword + regex matching)
 *   2. Merge adjacent high-signal segments into candidate windows
 *   3. Score windows with context boost + diversity bonus
 *   4. Return top-N candidates (default 35)
 *
 * Performance: O(N * S) where N=segments, S=signals. For N=747, S=15: <50ms.
 */

import type { TranscriptSegment } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CandidateWindow {
  startSegment: number;     // index into transcript array
  endSegment: number;       // inclusive
  startSeconds: number;     // segment.start
  endSeconds: number;       // segment.end
  durationSeconds: number;
  score: number;            // final score (normalized 0-100)
  signals: string[];        // which signal types fired
  signalCount: number;      // total raw signal matches
  diversity: number;        // unique signal types
  text: string;             // joined text of all segments
  // Speaker-aware fields (enriched post-extraction)
  speakers?: string[];      // Unique speakers in this window
  speakerChangeCount?: number; // Number of speaker transitions
  exchangeRate?: number;    // Transitions per minute
  primarySpeaker?: string;  // Speaker with most text
}

// ---------------------------------------------------------------------------
// V2 Signal Library (LOCKED)
// ---------------------------------------------------------------------------

interface SignalDef {
  weight: number;
  keywords: string[];
  regex?: RegExp[];
}

/**
 * V2 signals — tuned on 200 real segments from hN-V0YYDSak.
 *
 * Changes from v1:
 *   - REMOVED: hooks, cta, topic_shift (84-85% noise)
 *   - REDUCED weight: personal, strong_claims, questions, quotations
 *   - ADDED: vulnerability, inspiration signals
 *   - EXPANDED: emotion with Indonesian keywords (kasihan, mohon maaf, etc.)
 */
const SIGNALS: Record<string, SignalDef> = {
  // ── 1. EMOTION (weight 3) ──────────────────────────────────────────
  emotion: {
    weight: 3,
    keywords: [
      // Positive high-arousal
      'luar biasa', 'gila', 'sangat', 'banget', 'astaga', 'ya ampun',
      'menakjubkan', 'hebat', 'keren', 'mantap', 'sukses', 'berhasil',
      'bahagia', 'senang', 'excited', 'passion', 'cinta', 'sayang',
      'bangga', 'menang', 'juara', 'terbaik', 'paling',
      // Negative high-arousal
      'marah', 'kesal', 'benci', 'jijik', 'mual', 'sakit', 'sengsara',
      'menderita', 'tragis', 'mengerikan', 'horor', 'menyedihkan',
      'kecewa', 'frustrasi', 'stress', 'depresi', 'trauma', 'luka',
      'mati', 'meninggal', 'celaka', 'bencana', 'krisis', 'masalah',
      'konflik', 'perang', 'bentrok', 'ribut', 'hancur',
      // Indonesian-specific emotional
      'kasihan', 'mohon maaf', 'alhamdulillah', 'bersyukur',
      'insyaallah', 'astagfirullah', 'subhanallah', 'masyaallah',
      // English
      'amazing', 'incredible', 'shocking', 'unbelievable', 'insane',
      'love', 'hate', 'angry', 'furious', 'devastated', 'thrilled',
      'terrible', 'horrible', 'wonderful', 'fantastic', 'awful',
    ],
  },

  // ── 2. CONTROVERSY (weight 4) ──────────────────────────────────────
  controversy: {
    weight: 4,
    keywords: [
      'salah', 'keliru', 'tidak benar', 'bukan begitu', 'sebenarnya',
      'justru', 'malah', 'sebaliknya', 'kontroversi', 'protes',
      'menolak', 'membantah', 'kritik', 'mengkritik', 'keberatan',
      'tidak setuju', 'beda pendapat', 'bertengkar', 'debat',
      'polemik', 'skandal', 'tertuduh', 'fitnah', 'hoax', 'bohong',
      'tipu', 'korupsi', 'koruptor', 'penipuan', 'manipulasi',
      'konspirasi', 'teroris', 'radikal', 'sara',
      'wrong', 'disagree', 'controversy', 'scandal', 'accused',
      'deny', 'refute', 'debate', 'argument', 'conflict',
    ],
  },

  // ── 3. NUMBERS / STATISTICS (weight 3) ─────────────────────────────
  numbers: {
    weight: 3,
    keywords: [
      'persen', 'rata-rata', 'total', 'jumlah', 'angka', 'statistik',
      'data', 'survei', 'riset', 'penelitian', 'laporan', 'bukti',
      'fakta', 'nyata', 'hitung', 'hitungan', 'estimasi', 'prediksi',
    ],
    regex: [
      /\d+%/,
      /\d+\s*(juta|miliar|triliun|ribu)/i,
      /Rp\s*[\d,.]+/i,
      /\$\s*[\d,.]+/i,
      /\d+\s*(tahun|bulan|hari|jam|menit|detik)/i,
      /\d+\s*(orang|penonton|subscriber|follower)/i,
      /(pertama|kedua|ketiga|terakhir)/i,
    ],
  },

  // ── 4. QUESTIONS (weight 2 — reduced from v1) ──────────────────────
  questions: {
    weight: 2,
    keywords: [
      'apa', 'siapa', 'kenapa', 'bagaimana', 'kapan', 'dimana',
      'mengapa', 'gimana', 'apaan', 'tahukah', 'pernahkah',
      'bayangkan', 'tebak', 'siapa yang', 'apa yang',
      'what', 'who', 'why', 'how', 'when', 'where',
      'guess', 'imagine', 'did you know', 'ever wonder',
    ],
    regex: [/\?$/],
  },

  // ── 5. STRONG CLAIMS (weight 3 — reduced from 4) ───────────────────
  strong_claims: {
    weight: 3,
    keywords: [
      'pasti', 'yakin', 'jamin', 'garanti', 'serius', 'sumpah',
      'sungguh', 'betul', 'memang', 'tentu', 'jelas',
      'bukti', 'fakta', 'kebenaran', 'realita', 'kenyataan',
      'tidak bisa', 'mustahil', 'tidak mungkin', 'selalu', 'tidak pernah',
      'satu-satunya', 'terbesar', 'terpenting', 'nomor satu',
      'wajib', 'harus', 'jangan pernah', 'jangan sampai',
      'definitely', 'absolutely', 'guarantee', 'promise', 'swear',
      'never', 'always', 'only', 'must', 'have to',
      'truth', 'real', 'proven', 'certain',
    ],
  },

  // ── 6. SUPERLATIVES (weight 3) ─────────────────────────────────────
  superlatives: {
    weight: 3,
    keywords: [
      'terbaik', 'terburuk', 'terbesar', 'terkecil', 'tertinggi',
      'terendah', 'tercepat', 'terlama', 'terbaru',
      'pertama kali', 'sepanjang sejarah', 'tidak pernah ada',
      'paling hebat', 'paling keren', 'paling gila', 'paling mahal',
      'paling murah', 'paling cepat', 'paling lambat',
    ],
  },

  // ── 7. STORY TRANSITIONS (weight 3) ────────────────────────────────
  story_transitions: {
    weight: 3,
    keywords: [
      'dulu', 'dahulu', 'pernah', 'waktu itu', 'ketika', 'saat',
      'ceritanya', 'begini ceritanya', 'ini cerita', 'pengalaman',
      'kejadian', 'peristiwa', 'masa lalu', 'masa kecil',
      'awalnya', 'mulai dari', 'berawal',
      'terus tiba-tiba', 'lalu tiba-tiba', 'eh tiba-tiba',
      'ternyata', 'tahu-tahu', 'tak disangka', 'tidak diduga',
      'di situlah', 'di saat itulah', 'puncaknya', 'klimaks',
      'akhirnya', 'kesimpulannya', 'intinya', 'moralnya',
      'pelajarannya', 'hikmahnya', 'takeaway', 'pesan',
    ],
  },

  // ── 8. PROFANITY / TABOO (weight 4) ────────────────────────────────
  profanity: {
    weight: 4,
    keywords: [
      'anjing', 'babi', 'bangsat', 'brengsek', 'tolol', 'bodoh',
      'goblok', 'sialan', 'sial', 'tai', 'setan', 'iblis',
      'dosa', 'haram',
      'seks', 'sex', 'ciuman', 'pacaran', 'selingkuhan',
      'hamil', 'kandungan', 'aborsi', 'narkoba',
      'judi', 'prostitusi', 'psk',
    ],
  },

  // ── 9. SURPRISE / SHOCK (weight 4) ─────────────────────────────────
  surprise: {
    weight: 4,
    keywords: [
      'tidak menyangka', 'tidak duga', 'kaget', 'terkejut',
      'shock', 'shocked', 'surprised', 'unexpected', 'surprising',
      'gak nyangka', 'nggak nyangka', 'gak sangka',
      'wow', 'wah', 'aduh', 'ya ampun', 'astaga', 'astagfirullah',
      'subhanallah', 'masyaallah', 'yaallah', 'ya tuhan',
      'serius', 'beneran', 'masa', 'masa sih',
      'kamu nggak percaya', 'percaya nggak', 'gak percaya',
      'ini beneran', 'ini nyata', 'ini terjadi',
      'rahasia', 'ungkap', 'terungkap',
      'misteri', 'misterius', 'aneh', 'unik', 'langka',
      'shocking', 'unbelievable', 'can you believe',
      "you won't believe", 'plot twist',
      'secret', 'revealed', 'exposed', 'hidden truth',
    ],
  },

  // ── 10. MONEY / WEALTH (weight 3) ──────────────────────────────────
  money: {
    weight: 3,
    keywords: [
      'uang', 'duit', 'modal', 'investasi', 'saham', 'crypto',
      'bitcoin', 'trading', 'profit', 'untung', 'rugi',
      'penghasilan', 'gaji', 'omzet', 'revenue', 'income',
      'jutawan', 'miliarder', 'kaya', 'sukses', 'bisnis',
      'usaha', 'startup', 'perusahaan', 'brand', 'jualan',
      'jual', 'beli', 'harga', 'mahal', 'murah', 'gratis',
      'diskon', 'promo', 'cashback', 'cicilan', 'kredit',
      'hutang', 'pinjaman', 'bank', 'bunga',
    ],
  },

  // ── 11. AUTHORITY / CREDIBILITY (weight 2) ─────────────────────────
  authority: {
    weight: 2,
    keywords: [
      'profesor', 'dokter', 'ahli', 'pakar', 'expert', 'specialist',
      'ceo', 'founder', 'presiden', 'menteri', 'gubernur',
      'artis', 'selebriti', 'influencer', 'youtuber',
      'pengusaha', 'bos', 'atasan', 'pemimpin',
      'berpengalaman', 'veteran', 'senior',
      'sarjana', 'magister', 'doktor', 'phd', 'prof',
      'penghargaan', 'award', 'rekor',
    ],
  },

  // ── 12. QUOTATIONS (weight 2 — reduced from v1) ────────────────────
  quotations: {
    weight: 2,
    keywords: [
      'kata', 'bilang', 'ucap', 'tegas', 'ungkap',
      'mengatakan', 'menyebutkan', 'menjawab', 'bertanya',
      'meminta', 'memerintah', 'menasihati',
      'pesan', 'saran', 'nasihat', 'peringatan',
    ],
    regex: [/"[^"]*"/, /'[^']*'/],
  },

  // ── 13. PERSONAL REVELATION (weight 3 — reduced from 4) ────────────
  personal: {
    weight: 3,
    keywords: [
      'aku', 'saya', 'gue', 'gw', 'ane',
      'pengalaman', 'cerita', 'curhat', 'rahasia',
      'malu', 'menangis', 'nangis', 'sedih', 'depresi',
      'broken', 'gagal', 'jatuh', 'bangkit', 'move on',
      'mantan', 'ex', 'pacar', 'suami', 'istri', 'anak',
      'keluarga', 'orang tua', 'ibu', 'ayah', 'mama', 'papa',
      'sendirian', 'kesepian', 'sepi',
    ],
  },

  // ── 14. VULNERABILITY (weight 4 — NEW in v2) ───────────────────────
  vulnerability: {
    weight: 4,
    keywords: [
      'mohon maaf', 'maaf', 'salah', 'kesalahan',
      'malu', 'menangis', 'nangis', 'terisak',
      'gagal', 'jatuh', 'hancur', 'patah hati',
      'trauma', 'luka', 'sakit', 'menderita',
      'kesepian', 'sendirian', 'sepi',
      'tidak sempurna', 'imperfect', 'kelemahan',
      'jujur', 'terus terang', 'blak-blakan',
      'vulnerable', 'honest', 'raw',
    ],
  },

  // ── 15. INSPIRATION (weight 3 — NEW in v2) ─────────────────────────
  inspiration: {
    weight: 3,
    keywords: [
      'inspirasi', 'motivasi', 'semangat', 'passion',
      'impian', 'cita-cita', 'mimpi', 'dream',
      'bangkit', 'rise', 'juara', 'champion',
      'jangan menyerah', 'never give up', 'keep going',
      'percaya diri', 'confidence', 'yakin',
      'berani', 'courage', 'brave',
      'inspiring', 'motivational', 'uplifting',
    ],
  },

  // ── 16. EDUCATIONAL STRUCTURE (weight 3 — NEW) ─────────────────────
  educational_structure: {
    weight: 3,
    keywords: [
      'cara', 'langkah', 'tips', 'trik', 'tutorial', 'panduan',
      'pertama', 'kedua', 'ketiga', 'keempat', 'kelima',
      'step', 'caranya', 'begini', 'gini caranya',
      'rahasia', 'kunci', 'penting', 'wajib tahu', 'harus tahu',
      'satu hal', 'ingat', 'catat', 'note',
      'how to', 'step by step', 'guide', 'tutorial',
      'tip', 'trick', 'hack', 'secret', 'key',
      'important', 'must know', 'need to know', 'remember',
      'first', 'second', 'third', 'finally', 'in conclusion',
      'intinya', 'kesimpulannya', 'pelajarannya',
      'simple', 'mudah', 'gampang', 'praktis',
    ],
  },

  // ── 17. HOT TAKE / CONTRARIAN OPINION (weight 4 — NEW) ─────────────
  hot_take: {
    weight: 4,
    keywords: [
      'menurut gue', 'menurut gua', 'menurut saya', 'pendapat gue',
      'gue rasa', 'gua rasa', 'saya rasa', 'kalau gue bilang',
      'menurutku', 'menurut gw', 'kalau menurut',
      'gue berani bilang', 'saya berani bilang',
      'orang gak mau denger', 'jarang ada yang',
      'sebenarnya', 'justru', 'malah sebaliknya',
      'hot take', 'unpopular opinion', 'controversial opinion',
      'no one talks about', 'hear me out', 'i think',
      "people don't realize", 'the truth is',
      'sejujurnya', 'jujur aja', 'honestly',
      'beda', 'berbeda', 'lain dari yang lain',
      'pada padahal', 'orang bilang tapi',
    ],
  },

  // ── 18. CLIFFHANGER / CURIOSITY GAP (weight 3 — NEW) ──────────────
  cliffhanger: {
    weight: 3,
    keywords: [
      'tapi ternyata', 'eh ternyata', 'yang bikin kaget',
      'tau gak', 'mau tau', 'penasaran', 'tunggu dulu',
      'belum selesai', 'masih ada lagi', 'yang lebih parah',
      'plot twist', 'tebak apa', 'coba tebak',
      'yang gak disangka', 'tak disangka', 'nggak nyangka',
      'lanjut', 'cerita belum selesai',
      'but then', 'plot twist', 'wait for it', 'guess what',
      "you won't believe", 'the crazy part is',
      'it gets worse', 'it gets better',
      'dan ternyata', 'tiba-tiba', 'tau-tau',
      'puncaknya', 'klimaksnya', 'yang paling gila',
    ],
  },

  // ── 19. DEBATE ARC / DISAGREEMENT (weight 3 — NEW) ─────────────────
  debate_arc: {
    weight: 3,
    keywords: [
      'tapi kan', 'iya tapi', 'nggak gitu', 'bukan begitu',
      'gue nggak setuju', 'setuju sih tapi', 'masalahnya',
      'problemnya', 'sisi lain', 'di satu sisi',
      'emang bener', 'emang sih', 'oke fair',
      'tapi gua rasa', 'tapi saya rasa',
      'argumen', 'argument', 'perdebatan', 'debat',
      'but actually', 'i disagree', 'on the other hand',
      'the problem is', 'fair point but', 'counterpoint',
      'tapi kalo', 'tapi kalau',
      'sebenernya', 'sebetulnya',
    ],
    regex: [/[Aa]pakah\s+(itu|benar|betul)/, /[Bb]eneran\s+(sih|ya|kah)/],
  },

  // ── 20. BUSINESS / ENTREPRENEURSHIP (weight 3 — NEW) ──────────────
  business_entrepreneurship: {
    weight: 3,
    keywords: [
      'bisnis', 'usaha', 'startup', 'entrepreneur', 'wirausaha',
      'bangun bisnis', 'jalanin bisnis', 'mulai bisnis',
      'partner', 'mitra', 'investor', 'co-founder',
      'pendanaan', 'funding', 'seed', 'series',
      'marketing', 'pemasaran', 'branding', 'brand',
      'produk', 'product', 'launch', 'meluncurkan',
      'customer', 'pelanggan', 'market', 'pasar',
      'skalabilitas', 'scale', 'growth', 'tumbuh',
      'strategi', 'strategy', 'eksekusi', 'execution',
      'valuasi', 'valuation', 'exit', 'IPO',
      'business', 'startup', 'founder', 'venture',
      'B2B', 'B2C', 'SaaS', 'subscription',
      'bootstrapping', 'side hustle', 'passive income',
    ],
  },

  // ── 21. PREDICTIONS / FORECASTING (weight 2 — NEW) ─────────────────
  predictions_forecasting: {
    weight: 2,
    keywords: [
      'prediksi', 'ramalan', 'masa depan', 'ke depan',
      'tren', 'trend', 'akan datang', 'next',
      'dalam 5 tahun', 'dalam 10 tahun',
      'saya prediksi', 'gue prediksi', 'saya ramal',
      'bisa jadi', 'kemungkinan', 'mungkin saja',
      'predict', 'prediction', 'forecast', 'future',
      'in the next', 'coming years', 'will be',
      'saya lihat ke depan', 'saya yakin ke depannya',
      'saya rasa akan', 'nanti akan',
      'perubahan', 'perubahan besar', 'big change',
      'revolusi', 'evolusi', 'shift',
      'era baru', 'new era', 'next big thing',
      'the future of', 'trending', 'upcoming',
    ],
  },

  // ── 22. MISTAKES / FAILURES / LESSONS (weight 3 — NEW) ─────────────
  mistakes_failures: {
    weight: 3,
    keywords: [
      'gagal', 'kegagalan', 'jatuh', 'bangkrut', 'collapsed',
      'mistake', 'kesalahan', 'error', 'blunder',
      'pelajaran', 'lesson', 'lessons learned',
      'pengalaman pahit', 'bitter experience',
      'saya belajar', 'gue belajar', 'learned',
      'dulu saya', 'dulu gue', 'waktu itu saya',
      'ternyata salah', 'saya kira tapi ternyata',
      'if only', 'seandainya', 'kalau saja',
      'the hardest lesson', 'biggest mistake',
      'failure', 'failed', 'bankrupt', 'crash',
      'saya gagal', 'gue gagal', 'saya pernah gagal',
      'bangkit dari', 'rise from', 'mulai dari nol',
      'start from zero', 'lost everything', 'hancur',
      'saya akui', 'saya mengaku', 'i admit',
      'my biggest regret', 'my biggest mistake',
    ],
  },

  // ── 23. ACTIONABLE ADVICE (weight 2 — NEW) ─────────────────────────
  actionable_advice: {
    weight: 2,
    keywords: [
      'saran', 'advice', 'rekomendasi', 'recommendation',
      'harus', 'wajib', 'pastikan', 'jangan lupa',
      'coba', 'try', 'lakukan', 'implementasi',
      'terapkan', 'apply', 'practice',
      'langkah pertama', 'first step', 'mulailah',
      'yang perlu kamu', 'yang perlu lu', 'you need to',
      'tips', 'tip', 'pro tip', 'tips and tricks',
      'best practice', 'cara terbaik',
      'recommended', 'highly recommended',
      'jangan sampai', 'jangan pernah',
      'yang paling penting', 'most important',
      'kuncinya adalah', 'the key is',
      'solusinya', 'the solution',
    ],
  },

  // ── 24. SPEAKER DISAGREEMENT (weight 3 — NEW, Phase 3B) ────────────
  speaker_disagreement: {
    weight: 3,
    keywords: [
      'nggak setuju', 'ga setuju', 'tidak setuju', 'kurang setuju',
      'maksudnya gini', 'maksud gue', 'maksud saya',
      'bukan gitu', 'bukan begitu', 'nggak gitu',
      'tunggu dulu', 'wait wait', 'stop stop',
      'kalo gitu', 'kalau begitu', 'tapi kan',
      'iya iya tapi', 'iya sih tapi', 'iya tapi',
      'sebentar', 'sorry', 'maaf maaf',
      'testi dulu', 'tes dulu',
      'no no', 'hold on', 'hang on',
      'let me finish', 'let me explain',
      "that's not what", "that's not how",
      'bentar bentar', 'wait wait wait',
    ],
  },

  // ── 25. REACTION MOMENT (weight 2 — NEW, Phase 3B) ─────────────────
  reaction_moment: {
    weight: 2,
    keywords: [
      'wow', 'woww', 'woah', 'whoa', 'ohh', 'ahh',
      'ya ampun', 'astaga', 'astagfirullah', 'subhanallah',
      'masyaallah', 'yaallah', 'ya tuhan',
      'serius?', 'beneran?', 'really?', 'for real?',
      'gila', 'anjir', 'anjay', 'waduh', 'aduh',
      'what?', 'wait what', 'no way', 'omg', 'oh my god',
      'masa sih', 'masa', 'seriusan',
      'gitu', 'oh gitu', 'oh begitu',
      'nah', 'nah gitu', 'nah ini',
      'iya dong', 'iya lah', 'yes yes',
      'tuh kan', 'nah kan', 'udah gue bilang',
      'hahaha', 'wkwk', 'haha', 'hehe', 'hihi',
      'laughter', 'laughs', 'laughing',
    ],
    regex: [
      /\(laughs?\)/i, /\(laughter\)/i, /\(applause\)/i,
    ],
  },
};

// ---------------------------------------------------------------------------
// Sentence Boundary Recovery (SBR)
// ---------------------------------------------------------------------------

const SBR_START_WORDS = [
  'nah', 'jadi', 'terus', 'sebetulnya', 'sebenernya',
  'misalnya', 'waktu itu', 'dulu', 'pernah', 'kalau',
  'kenapa', 'gimana', 'bagaimana',
];

const SBR_CONTAINS = ['?', 'ceritanya', 'awalnya', 'suatu hari', 'tiba-tiba'];

const MAX_SBR_SCAN = 3;

/**
 * Format seconds to MM:SS timestamp for logging.
 */
function fmtTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Scan backward from a candidate window's start segment to find a natural
 * sentence/thought boundary. Returns the best recovery index, or null if
 * no boundary found within scan range.
 *
 * Scans from closest to furthest (extStart-1 → extStart-2 → extStart-3)
 * and picks the FIRST match — minimal viable expansion.
 */
function recoverSentenceBoundary(
  text: string,
): { found: boolean; reason: string } {
  const lower = text.toLowerCase().trim();

  for (const word of SBR_START_WORDS) {
    if (lower.startsWith(word)) {
      return { found: true, reason: `startsWith("${word}")` };
    }
  }

  for (const pattern of SBR_CONTAINS) {
    if (lower.includes(pattern)) {
      return { found: true, reason: `contains("${pattern}")` };
    }
  }

  return { found: false, reason: 'no_boundary_found' };
}

// ---------------------------------------------------------------------------
// Segment Scoring
// ---------------------------------------------------------------------------

interface SegmentScore {
  rawScore: number;
  signalMatches: Record<string, number>;  // signal name → match count
}

/**
 * Score a single transcript segment against all signals.
 */
function scoreSegment(text: string): SegmentScore {
  const lower = text.toLowerCase();
  const signalMatches: Record<string, number> = {};
  let rawScore = 0;

  for (const [name, def] of Object.entries(SIGNALS)) {
    let count = 0;

    // Keyword matching
    for (const kw of def.keywords) {
      const kwLower = kw.toLowerCase();
      let idx = lower.indexOf(kwLower);
      while (idx !== -1) {
        count++;
        idx = lower.indexOf(kwLower, idx + 1);
      }
    }

    // Regex matching
    if (def.regex) {
      for (const re of def.regex) {
        const matches = text.match(new RegExp(re.source, re.flags + (re.flags.includes('g') ? '' : 'g')));
        if (matches) count += matches.length;
      }
    }

    if (count > 0) {
      signalMatches[name] = count;
      rawScore += def.weight * count;
    }
  }

  return { rawScore, signalMatches };
}

// ---------------------------------------------------------------------------
// Window Formation
// ---------------------------------------------------------------------------

/**
 * Merge adjacent high-signal segments into candidate windows.
 *
 * Algorithm:
 *   1. Mark segments with rawScore > 0 as "active"
 *   2. Group consecutive active segments into windows
 *   3. Extend windows by 1 segment on each side for context
 *   4. Filter windows by duration (15-90 seconds)
 */
function formWindows(
  segments: TranscriptSegment[],
  scores: SegmentScore[],
  minDuration: number = 8,
  maxDuration: number = 120,
): CandidateWindow[] {
  const windows: CandidateWindow[] = [];
  const n = segments.length;

  // Find active segments (score > 0)
  const active = scores.map(s => s.rawScore > 0);

  let i = 0;
  while (i < n) {
    if (!active[i]) { i++; continue; }

    // Found start of a cluster — extend as far as possible
    let j = i;
    while (j < n && active[j]) j++;

    // j is now the first inactive segment after the cluster
    // Extend by 1 segment on each side for context (if possible)
    let extStart = Math.max(0, i - 1);
    const extEnd = Math.min(n - 1, j);  // j is already past the last active

    // ── Sentence Boundary Recovery ──────────────────────────────────
    // Scan up to MAX_SBR_SCAN segments backward from extStart.
    // If a natural boundary is found, shift extStart to that segment.
    // Pick the FIRST boundary found (closest to original → minimal shift).
    const sbrStart = extStart;
    const sbrLimit = Math.max(0, extStart - MAX_SBR_SCAN);
    for (let sbr = sbrStart - 1; sbr >= sbrLimit; sbr--) {
      const result = recoverSentenceBoundary(segments[sbr].text);
      if (result.found) {
        const candidateDuration = (segments[extEnd].start + segments[extEnd].duration) - segments[sbr].start;
        if (candidateDuration <= maxDuration) {
          const origSec = segments[extStart].start;
          extStart = sbr;
          console.log(
            `[SBR] Candidate shifted: original=${fmtTimestamp(origSec)} recovered=${fmtTimestamp(segments[sbr].start)} reason="${result.reason}"`
          );
        } else {
          console.log(
            `[SBR] Candidate FOUND but DROPPED (exceeds ${maxDuration}s): original=${fmtTimestamp(segments[extStart].start)} boundary_at=${fmtTimestamp(segments[sbr].start)} reason="${result.reason}"`
          );
        }
        break; // first match (closest to original), stop scanning
      }
    }
    if (extStart === sbrStart) {
      console.log(`[SBR] Candidate unchanged: start=${fmtTimestamp(segments[extStart].start)} reason="no_boundary_found"`);
    }
    // ── End SBR ─────────────────────────────────────────────────────

    const startSec = segments[extStart].start;
    const endSeg = segments[extEnd];
    const endSec = endSeg.start + endSeg.duration;
    const duration = endSec - startSec;

    if (duration >= minDuration && duration <= maxDuration) {
      // Build window
      const windowSegments = segments.slice(extStart, extEnd + 1);
      const windowScores = scores.slice(extStart, extEnd + 1);

      // Aggregate signal matches
      const allSignals: Record<string, number> = {};
      let totalRawScore = 0;
      for (const ws of windowScores) {
        totalRawScore += ws.rawScore;
        for (const [sig, cnt] of Object.entries(ws.signalMatches)) {
          allSignals[sig] = (allSignals[sig] || 0) + cnt;
        }
      }

      // Context boost: check 3 segments before and after
      let contextScore = 0;
      for (let c = Math.max(0, extStart - 3); c < extStart; c++) {
        contextScore += scores[c].rawScore;
      }
      for (let c = extEnd + 1; c <= Math.min(n - 1, extEnd + 3); c++) {
        contextScore += scores[c].rawScore;
      }
      const contextBoost = 1 + 0.1 * contextScore;

      // Diversity bonus
      const uniqueSignals = Object.keys(allSignals).length;
      const diversityBonus = 1 + 0.15 * uniqueSignals;

      // Duration normalization: divide by √duration to prevent bias toward long windows
      const durationNorm = Math.sqrt(duration);

      // Duration tier bonus: prefer punchy clips (8-45s) over long form
      let durationTierBonus: number;
      if (duration >= 8 && duration <= 15) {
        durationTierBonus = 1.1;       // Punchline clips — tight, high impact
      } else if (duration >= 16 && duration <= 45) {
        durationTierBonus = 1.15;      // Sweet spot — TikTok/Reels optimal
      } else if (duration >= 46 && duration <= 75) {
        durationTierBonus = 1.0;       // Standard length
      } else {
        durationTierBonus = 0.9;       // Long form — needs more signal density
      }

      const windowScore = (totalRawScore / durationNorm) * contextBoost * diversityBonus * durationTierBonus;

      windows.push({
        startSegment: extStart,
        endSegment: extEnd,
        startSeconds: startSec,
        endSeconds: endSec,
        durationSeconds: duration,
        score: windowScore,
        signals: Object.keys(allSignals),
        signalCount: Object.values(allSignals).reduce((a, b) => a + b, 0),
        diversity: uniqueSignals,
        text: windowSegments.map(s => s.text).join(' '),
      });
    }

    i = j + 1;
  }

  return windows;
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Extract candidate windows from a transcript using V2 signal library.
 *
 * @param transcript - Full transcript segments
 * @param maxCandidates - Maximum candidates to return (default 35)
 * @returns CandidateWindow[] sorted by score descending, length ≤ maxCandidates
 */
export function extractCandidates(
  transcript: TranscriptSegment[],
  maxCandidates: number = 35,
): CandidateWindow[] {
  if (transcript.length === 0) return [];

  // Step 1: Score each segment
  const scores = transcript.map(seg => scoreSegment(seg.text));

  // Step 2: Form candidate windows
  const windows = formWindows(transcript, scores);

  // Step 3: Sort by score descending
  windows.sort((a, b) => b.score - a.score);

  // Step 4: Normalize scores to 0-100
  if (windows.length > 0) {
    const maxScore = windows[0].score;
    if (maxScore > 0) {
      for (const w of windows) {
        w.score = Math.round((w.score / maxScore) * 100 * 10) / 10;
      }
    }
  }

  // Step 5: Return top-N
  return windows.slice(0, maxCandidates);
}

/**
 * Post-extraction speaker enrichment for candidate windows.
 *
 * After candidates are extracted, enriches each with speaker metadata
 * from the transcript. This is a separate step so the core extraction
 * pipeline remains unchanged.
 *
 * Gracefully handles missing speaker data — candidates without speaker
 * info are returned unchanged.
 *
 * @param candidates  - Extracted candidate windows (pre-ranking)
 * @param transcript  - Full transcript with optional speaker field
 * @returns Same candidates with speaker metadata populated
 */
export function enrichCandidatesWithSpeakerData(
  candidates: CandidateWindow[],
  transcript: TranscriptSegment[],
): CandidateWindow[] {
  // Check if transcript has speaker data
  const hasSpeakers = transcript.some(s => s.speaker !== undefined && s.speaker !== 'mixed');
  if (!hasSpeakers) return candidates;

  for (const c of candidates) {
    const windowSpeakers = new Set<string>();
    let changes = 0;
    let lastSpeaker: string | undefined;

    for (let i = c.startSegment; i <= c.endSegment; i++) {
      const seg = transcript[i];
      if (!seg) continue;
      const s = seg.speaker;
      if (!s || s === 'mixed') continue;

      windowSpeakers.add(s);
      if (lastSpeaker && s !== lastSpeaker) {
        changes++;
      }
      lastSpeaker = s;
    }

    // Compute speaker text totals for primary speaker
    const speakerBytes: Record<string, number> = {};
    for (let i = c.startSegment; i <= c.endSegment; i++) {
      const seg = transcript[i];
      if (!seg || !seg.speaker || seg.speaker === 'mixed') continue;
      speakerBytes[seg.speaker] = (speakerBytes[seg.speaker] || 0) + seg.text.length;
    }

    const speakerList = [...windowSpeakers];
    c.speakers = speakerList;
    c.speakerChangeCount = changes;
    c.exchangeRate = c.durationSeconds > 0
      ? Math.round((changes / c.durationSeconds) * 60 * 10) / 10
      : 0;
    c.primarySpeaker = speakerList.length > 0
      ? speakerList.sort((a, b) => (speakerBytes[b] || 0) - (speakerBytes[a] || 0))[0]
      : undefined;
  }

  return candidates;
}
