import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    sha: process.env.GIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'unknown',
    buildTimestamp: process.env.BUILD_TIMESTAMP ?? process.env.VERCEL_GIT_COMMIT_TIMESTAMP ?? 'unknown',
    deployVersion: process.env.DEPLOY_VERSION ?? 'unknown',
  });
}
