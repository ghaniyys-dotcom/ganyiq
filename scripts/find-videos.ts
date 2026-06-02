/**
 * Aggressive search for accessible YouTube videos from this IP.
 */
const UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';
const API = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

async function test(id: string, label: string): Promise<boolean> {
  try {
    const resp = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
        videoId: id,
      }),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (tracks.length === 0) return false;
    const track = tracks[0];
    if (!track?.baseUrl) return false;
    const xmlResp = await fetch(track.baseUrl, { headers: { 'User-Agent': UA } });
    const xml = await xmlResp.text();
    const hasContent = xml.includes('<p t="') || xml.includes('<text start="');
    if (!hasContent) return false;
    
    const lang = track.languageCode || '?';
    const kind = track.kind === 'asr' ? 'ASR' : 'manual';
    console.log('✅ ' + label + ' (' + id + ') - lang=' + lang + ' (' + kind + ')');
    return true;
  } catch {
    return false;
  }
}

const CANDIDATES = [
  // Business / Entrepreneurship
  { id: 'CDXGmM86cIs', label: 'Naval - How to Get Rich' },
  { id: '3qHkcs3kH4Q', label: 'My Million Dollar Mistake' },
  { id: 'kYfNvmF0pBc', label: 'TED - How to speak so people listen' },
  { id: 'p7ozGCEfCbI', label: 'The single biggest reason why startups succeed' },
  { id: '9vJRopau0g0', label: 'Think Fast, Talk Smart' },
  
  // Motivation
  { id: 'zOEa6JbGDns', label: 'David Goggins Motivation' },
  { id: '6eX2UUKq_ZA', label: 'The Art of Letting Go' },
  { id: 'XqZsoesa55w', label: 'Elon Musk - The Future' },
  { id: 'D1R-jKKp3NA', label: 'Why the secret to success is failure' },
  
  // Comedy
  { id: 'V4gJcniNTCY', label: 'Ricky Gervais Humanity' },
  { id: 'fFQ9BcQv_rM', label: 'Bo Burnham - Welcome to the Internet' },
  { id: 'gnViJVqBq30', label: 'Jimmy Carr Funny Business' },
  { id: 'dPmbT5X4Y7M', label: 'Ali Wong Baby Cobra' },
  
  // Finance
  { id: 'mGQlcyRzmVo', label: 'Warren Buffett 5 Rules' },
  { id: 'BW3DQkFhSXg', label: 'Robert Kiyosaki Rich Dad' },
  { id: 'E2htQ6VK_vs', label: 'The power of compound interest' },
  { id: 'q8vMxLWkhjs', label: 'How to become a millionaire' },
  
  // Educational/Storytelling
  { id: 'f7lL7mJ7H4c', label: 'Kurzgesagt Optimistic Nihilism' },
  { id: 'JwW6mGMbNpE', label: 'The Science of Storytelling' },
  { id: 'zhl-Cs1-sG4', label: 'The chemical mind BBC' },
  { id: 'h0q1Qc7wQlY', label: 'Why people believe conspiracy theories' },
  
  // Controversy/Debate
  { id: 'K2GJ6o3xU0I', label: 'Sam Harris and Jordan Peterson' },
  { id: 't71r7fPk9pU', label: 'Ben Shapiro Debate' },
  { id: 'GZgJgwhqsVk', label: 'Lex Fridman and Yuval Noah Harari' },
  { id: 'bm-6xy5eFS4', label: 'Diary of a CEO and Andrew Huberman' },
  
  // Indonesian content (long shot)
  { id: 'zn3CYlJxw8I', label: 'Deddy Corbuzier Close the Door' },
  { id: 'CVLzBCRSEYk', label: 'Raditya Dika Stand Up' },
  { id: 'R8rLV9PhQg0', label: 'Tom Lembong Interview' },
  
  // Music / Pop culture (usually ASR)
  { id: 'dQw4w9WgXcQ', label: 'Rick Astley control' },
  { id: 'JGwWNGJdvx8', label: 'Ed Sheeran Shape of You' },
  { id: 'kffacxfA7G4', label: 'Adele Hello' },
  
  // Tech / Science
  { id: 'Hm8YnFc4h-A', label: 'Simon Sinek Start With Why' },
  { id: '0af00U0ADcI', label: '3Blue1Brown Essence of calculus' },
  { id: 'r6sGWTCMz2k', label: 'Veritasium How Electricity works' },
  { id: 'u4ZoJKF_VuA', label: 'Simon Sinek TED' },
  { id: 'UF8uR6Z6KLc', label: 'Steve Jobs Stanford Speech' },
];

async function main() {
  console.log('Searching for accessible videos...\n');
  const working: typeof CANDIDATES = [];
  
  for (const v of CANDIDATES) {
    const result = await test(v.id, v.label);
    if (result) {
      working.push(v);
      if (working.length >= 10) break;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  
  console.log('\n--- SUMMARY ---');
  console.log(working.length + ' videos accessible');
  working.forEach(v => console.log('  ' + v.id + ' - ' + v.label));
}

main().catch(console.error);
