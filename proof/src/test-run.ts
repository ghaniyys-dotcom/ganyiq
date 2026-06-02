import { Innertube, UniversalCache } from "youtubei.js";

async function main() {
  console.log("Initializing Innertube with cache enabled...");
  const yt = await Innertube.create({
    cache: new UniversalCache(true)
  });
  
  const videoId = "dQw4w9WgXcQ"; // Control test video (Rickroll)
  console.log(`Fetching info for video: ${videoId}...`);
  const info = await yt.getInfo(videoId);

  console.log(`Video Title: ${info.basic_info.title}`);
  console.log(`Video Channel: ${info.basic_info.author}`);
  console.log(`Video Duration: ${info.basic_info.duration} seconds`);
  
  try {
    console.log("Fetching transcript using getTranscript()...");
    const transcriptInfo = await info.getTranscript();
    console.log("Transcript fetched successfully!");
    console.log("Languages available:", transcriptInfo.languages);
  } catch (err) {
    console.error("Failed to fetch transcript via getTranscript():", err);
  }
}

main().catch(console.error);
