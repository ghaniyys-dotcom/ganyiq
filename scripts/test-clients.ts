/**
 * Test different InnerTube client contexts for caption accessibility.
 */
const INNERTUBE_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CLIENTS = [
  { name: 'ANDROID', clientName: 'ANDROID', clientVersion: '20.10.38', ua: INNERTUBE_UA },
  { name: 'ANDROID_MUSIC', clientName: 'ANDROID_MUSIC', clientVersion: '7.08.51', ua: INNERTUBE_UA },
  { name: 'WEB', clientName: 'WEB', clientVersion: '2.20241201.00.00', ua: WEB_UA },
  { name: 'WEB_REMIX', clientName: 'WEB_REMIX', clientVersion: '1.20241201.00.00', ua: WEB_UA },
  { name: 'TVHTML5', clientName: 'TVHTML5_SIMPLY', clientVersion: '7.20241201.00.00', ua: WEB_UA },
  { name: 'IOS', clientName: 'IOS', clientVersion: '20.10.38', ua: 'com.google.ios.youtube/20.10.38 (iPhone; iOS 18.0;)' },
];

const TEST_VIDEOS = [
  { id: 'dQw4w9WgXcQ', title: 'Rick Astley (control)' },
  { id: 'R8rLV9PhQg0', title: 'Tom Lembong Interview' },
  { id: 'gnViJVqBq30', title: 'Jimmy Carr Comedy' },
  { id: 'V4gJcniNTCY', title: 'Ricky Gervais' },
  { id: 'CDXGmM86cIs', title: 'Naval How to Get Rich' },
  { id: 'JwW6mGMbNpE', title: 'Science of Storytelling' },
  { id: 'kYfNvmF0pBc', title: 'TED - How to speak' },
  { id: 'Hm8YnFc4h-A', title: 'Simon Sinek Inspire' },
  { id: 't71r7fPk9pU', title: 'Ben Shapiro Debate' },
  { id: 'K2GJ6o3xU0I', title: 'Peterson vs Harris' },
  { id: 'f7lL7mJ7H4c', title: 'Kurzgesagt' },
  { id: 'mGQlcyRzmVo', title: 'Warren Buffett' },
];

async function testVideoClient(videoId: string, title: string) {
  for (const client of CLIENTS) {
    try {
      const resp = await fetch(
        `https://www.youtube.com/youtubei/v1/player?prettyPrint=false`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': client.ua },
          body: JSON.stringify({
            context: { client: { clientName: client.clientName, clientVersion: client.clientVersion } },
            videoId,
          }),
        }
      );
      const data = await resp.json();
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

      if (tracks.length > 0) {
        const track = tracks.find((t: any) => t.languageCode === 'en' || t.languageCode === 'id') || tracks[0];
        // Quick fetch test
        if (track.baseUrl) {
          const xmlResp = await fetch(track.baseUrl, {
            headers: { 'User-Agent': client.ua },
          });
          const xmlText = await xmlResp.text();
          const hasContent = xmlText.includes('<p t="') || xmlText.includes('<text start="');
          if (hasContent) {
            console.log(`✅ ${title} | client=${client.name} | lang=${track.languageCode}${track.kind === 'asr' ? ' (ASR)' : ''} | ${tracks.length} tracks`);
            return true;
          }
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`❌ ${title} — No client worked`);
  return false;
}

async function main() {
  console.log('Testing multi-client caption discovery...\n');
  let count = 0;
  for (const v of TEST_VIDEOS) {
    const ok = await testVideoClient(v.id, v.title);
    if (ok) count++;
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`\n${count}/${TEST_VIDEOS.length} videos accessible`);
}

main().catch(console.error);
