export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  INVALID_URL: new AppError('INVALID_URL', 'Not a valid YouTube URL.', 400),
  TRANSCRIPT_UNAVAILABLE: new AppError('TRANSCRIPT_UNAVAILABLE', 'No transcript found for this video. Try a video with captions enabled.', 404),
  VIDEO_TOO_LONG: new AppError('VIDEO_TOO_LONG', 'Video exceeds the 180-minute limit.', 400),
  RATE_LIMITED: new AppError('RATE_LIMITED', 'You have exceeded the daily analysis limit. Try again tomorrow.', 429),
  ANALYSIS_FAILED: new AppError('ANALYSIS_FAILED', 'Analysis failed. Please try again.', 500),
} as const;
