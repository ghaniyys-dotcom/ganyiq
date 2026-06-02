export interface TestVideo {
  id: string;
  name: string;
  channel: string;
  youtubeUrl: string;
  youtubeId: string;
  niche: "controversy" | "business" | "comedy" | "general" | "control";
  notes: string;
}

/**
 * Permanent test suite of Indonesian podcasts and control videos.
 * These are selected to validate the dual hypothesis of Phase 0.5:
 * 1. Indonesian transcript extraction quality via youtubei.js
 * 2. Worth-clipping identification and ranking capabilities of Gemini
 */
export const TEST_VIDEOS: TestVideo[] = [
  {
    id: "corbuzier-indro",
    name: "Deddy Corbuzier x Indro Warkop",
    channel: "Deddy Corbuzier",
    youtubeUrl: "https://www.youtube.com/watch?v=S01H9t2N_Z0",
    youtubeId: "S01H9t2N_Z0",
    niche: "controversy",
    notes: "High emotional stakes, cultural commentary, rich in comedy history and Indonesian cultural nuances."
  },
  {
    id: "sumargo-richard",
    name: "Curhat Bang Denny Sumargo x Richard Lee",
    channel: "Denny Sumargo",
    youtubeUrl: "https://www.youtube.com/watch?v=kYx4W3yQ2eA",
    youtubeId: "kYx4W3yQ2eA",
    niche: "business",
    notes: "Excellent test for 'money' and 'controversy' DNA tags. Strong verbal cues and high engagement potential."
  },
  {
    id: "awal-minggu",
    name: "Podcast Awal Minggu - Adriano Qalbi",
    channel: "Adriano Qalbi",
    youtubeUrl: "https://www.youtube.com/watch?v=48-M2y0g5qI",
    youtubeId: "48-M2y0g5qI",
    niche: "comedy",
    notes: "Indonesian relatable humor, storytelling, monolog format. Tests model capacity to extract sub-textual humor."
  },
  {
    id: "boy-william-ldr",
    name: "UNSPOKEN Boy William",
    channel: "Boy William",
    youtubeUrl: "https://www.youtube.com/watch?v=H74rK2C47vI",
    youtubeId: "H74rK2C47vI",
    niche: "general",
    notes: "Bilingual (Bahasa Indonesia & English) conversation. Tests how robust the pipeline is with mixed-language podcasts."
  },
  {
    id: "rickroll-control",
    name: "Rick Astley - Never Gonna Give You Up (Control)",
    channel: "Rick Astley",
    youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    youtubeId: "dQw4w9WgXcQ",
    niche: "control",
    notes: "Standard English music video fallback to test absolute parser sanity and basic timestamp coordination."
  }
];
