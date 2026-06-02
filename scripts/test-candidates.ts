/**
 * Quick test: check which YouTube videos have transcripts accessible from this IP.
 * Tests caption track discovery via InnerTube API.
 */
import { Innertube, UniversalCache } from 'youtubei.js';

const INNERTUBE_PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const INNERTUBE_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';

const TEST_VIDEOS = [
  // Business / Leadership
  { id: 'u4ZoJKF_VuA', title: 'Simon Sinek - Start With Why (TED)', cat: 'business' },
  { id: 'Hm8YnFc4h-A', title: 'How great leaders inspire action', cat: 'business' },
  // Motivation
  { id: 'UF8uR6Z6KLc', title: 'Steve Jobs Stanford Commencement', cat: 'motivation' },
  { id: 'TuwfQ2J_7aQ', title: 'Arnold Schwarzenegger Motivation', cat: 'motivation' },
  // Comedy
  { id: 'V4gJcniNTCY', title: 'Ricky Gervais - Humanity', cat: 'comedy' },
  { id: 'gnViJVqBq30', title: 'Jimmy Carr - Funny Business', cat: 'comedy' },
  // Finance / Tech
  { id: 'CDXGmM86cIs', title: 'Naval - How to Get Rich', cat: 'finance' },
  { id: 'mGQlcyRzmVo', title: 'Warren Buffett - 5 Rules', cat: 'finance' },
  // Storytelling / Educational
  { id: 'f7lL7mJ7H4c', title: 'Kurzgesagt - Optimistic Nihilism', cat: 'educational' },
  { id: 'JwW6mGMbNpE', title: 'Science of Storytelling', cat: 'storytelling' },
  // Controversy / Debate
  { id: 'K2GJ6o3xU0I', title: 'Sam Harris vs Jordan Peterson', cat: 'controversy' },
  { id: 't71r7fPk9pU', title: 'Ben Shapiro - Debate', cat: 'controversy' },
  // Bonus: Indonesian content that might work
  { id: 'R8rLV9PhQg0', title: 'Tom Lembong - Interview (ID)', cat: 'business' },
  { id: 'zn3CYlJxw8I', title: 'Deddy Corbuzier - Podcast (ID)', cat: 'comedy' },
];

async function testVideo(videoId: string, cat: string, title: string) {
  try {
    // Test InnerTube caption track discovery
    const resp = await fetch(INNERTUBE_PLAYER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': INNERTUBE_UA },
      body: JSON.stringify({
        context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
        videoId,
      }),
    });

    if (!resp.ok) {
      console.log(`❌ [${cat}] ${title} — HTTP ${resp.status}`);
      return;
    }

    const data = await resp.json();
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const hasTimedtext = data?.captions?.playerCaptionsTracklistRenderer !== undefined;

    if (tracks.length === 0 && !hasTimedtext) {
      console.log(`❌ [${cat}] ${title} — No caption tracks`);
      return;
    }

    // Check if at least one track has a baseUrl we can fetch
    const testTrack = tracks[0];
    if (!testTrack?.baseUrl) {
      console.log(`❌ [${cat}] ${title} — Has tracks but no baseUrl`);
      return;
    }

    // Quick test: fetch 1st page of XML
    const xmlResp = await fetch(testTrack.baseUrl, {
      headers: { 'User-Agent': INNERTUBE_UA },
    });
    const xmlText = await xmlResp.text();
    const hasContent = xmlText.includes('<p t="') || xmlText.includes('<text start="');

    if (hasContent) {
      console.log(`✅ [${cat}] ${title} — ${tracks.length} tracks, language: ${testTrack.languageCode}, ${tracks.find((t: any) => t.kind === 'asr') ? 'ASR' : 'manual'}, XML has content ✓`);
    } else {
      console.log(`⚠️ [${cat}] ${title} — ${tracks.length} tracks but XML empty`);
    }
  } catch (e: any) {
    console.log(`❌ [${cat}] ${title} — Error: ${e.message?.slice(0, 60)}`);
  }
}

async function main() {
  console.log('Testing video transcript availability...\n');
  for (const v of TEST_VIDEOS) {
    await testVideo(v.id, v.cat, v.title);
    await new Promise(r => setTimeout(r, 2000)); // 2s delay between tests
  }
}

main().catch(console.error);
