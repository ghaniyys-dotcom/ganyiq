import crypto from "crypto";
import fs from "fs";

const CACHE_FILE =
  "./eval/evaluator-cache.json";

export function hashTranscript(
  transcript: string
) {
  return crypto
    .createHash("sha256")
    .update(transcript)
    .digest("hex");
}

export function getCachedResult(
  transcript: string
) {
  if (!fs.existsSync(CACHE_FILE))
    return null;

  const cache =
    JSON.parse(
      fs.readFileSync(
        CACHE_FILE,
        "utf8"
      )
    );

  return cache[
    hashTranscript(transcript)
  ] || null;
}

export function saveCachedResult(
  transcript: string,
  result: any
) {
  let cache: Record<string, any> = {};

  if (fs.existsSync(CACHE_FILE)) {
    cache = JSON.parse(
      fs.readFileSync(
        CACHE_FILE,
        "utf8"
      )
    );
  }

  cache[
    hashTranscript(transcript)
  ] = result;

  fs.writeFileSync(
    CACHE_FILE,
    JSON.stringify(
      cache,
      null,
      2
    )
  );
}
