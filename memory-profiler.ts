/**
 * worker-package/memory-profiler.ts — Memory profiling for GANYIQ render pipeline
 *
 * Logs RAM usage of node.exe, python.exe, ffmpeg.exe, and system-level RAM.
 * Works on both Windows (PC-GANY) and Linux (VPS worker).
 *
 * Usage:
 *   import { logMemory, logMemoryStart, logMemoryEnd, startMemoryTracking, stopMemoryTracking } from './memory-profiler';
 *   startMemoryTracking(5000); // starts periodic 5s snapshot logging
 *   logMemoryStart('diarization');
 *   // ... do work ...
 *   logMemoryEnd('diarization');
 *   stopMemoryTracking(); // prints peak report
 */
import { execSync } from 'child_process';
import { platform } from 'os';

const IS_WIN = platform() === 'win32';

export interface MemorySnapshot {
  nodeMB: number;
  pythonMB: number;
  ffmpegMB: number;
  totalSystemMB: number;
  availableMB: number;
}

// Running peak tracker (module-level)
const peaks: MemorySnapshot = { nodeMB: 0, pythonMB: 0, ffmpegMB: 0, totalSystemMB: 0, availableMB: 0 };
let totalSamples = 0;

/**
 * Take a memory snapshot using OS-level commands.
 * Windows: wmic + tasklist
 * Linux:   free + ps
 */
export function takeSnapshot(): MemorySnapshot {
  const snap: MemorySnapshot = { nodeMB: 0, pythonMB: 0, ffmpegMB: 0, totalSystemMB: 0, availableMB: 0 };

  try {
    if (IS_WIN) {
      // ── Windows ──
      // System RAM (one wmic call)
      try {
        const wmicOut = execSync(
          'wmic OS get TotalVisibleMemorySize,FreePhysicalMemory /FORMAT:CSV',
          { encoding: 'utf-8', timeout: 8000 },
        );
        const lines = wmicOut.trim().split('\n').filter(l => l.trim());
        if (lines.length >= 2) {
          const parts = lines[1].split(',');
          snap.totalSystemMB = Math.round(parseInt(parts[1], 10) / 1024);
          snap.availableMB = Math.round(parseInt(parts[2], 10) / 1024);
        }
      } catch { /* wmic not available or failed */ }

      // Process memory (single wmic query for all 3 processes)
      try {
        const wmicProc = execSync(
          'wmic process where "name=\'node.exe\' or name=\'python.exe\' or name=\'ffmpeg.exe\'" get Name,WorkingSetSize /FORMAT:CSV',
          { encoding: 'utf-8', timeout: 8000 },
        );
        const lines = wmicProc.trim().split('\n').filter(l => l.trim());
        // Skip header row
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split(',');
          if (parts.length < 2) continue;
          const procName = parts[0].trim().toLowerCase();
          const wsKB = Math.round(parseInt(parts[1], 10) / 1024); // WorkingSetSize is in bytes → KB
          if (wsKB <= 0) continue;

          if (procName === 'node.exe') snap.nodeMB += Math.round(wsKB / 1024);
          else if (procName === 'python.exe') snap.pythonMB += Math.round(wsKB / 1024);
          else if (procName === 'ffmpeg.exe') snap.ffmpegMB += Math.round(wsKB / 1024);
        }
      } catch { /* wmic process query failed */ }

      // Fallback: tasklist if wmic failed
      if (snap.nodeMB === 0 && snap.pythonMB === 0 && snap.ffmpegMB === 0) {
        for (const [procName, key] of [['node.exe', 'nodeMB'], ['python.exe', 'pythonMB'], ['ffmpeg.exe', 'ffmpegMB']] as const) {
          try {
            const taskOut = execSync(
              `tasklist /FI "IMAGENAME eq ${procName}" /FO CSV /NH`,
              { encoding: 'utf-8', timeout: 5000 },
            );
            const taskLines = taskOut.trim().split('\n').filter(l => l.includes(procName));
            for (const line of taskLines) {
              const parts = line.split(',');
              if (parts.length >= 5) {
                snap[key] += Math.round(parseInt(parts[4].replace(/[^0-9]/g, ''), 10) / 1024);
              }
            }
          } catch { /* tasklist failed for this process */ }
        }
      }
    } else {
      // ── Linux ──
      // System RAM
      try {
        const freeOut = execSync('free -m', { encoding: 'utf-8', timeout: 5000 });
        const memLine = freeOut.split('\n').find(l => l.startsWith('Mem:'));
        if (memLine) {
          const parts = memLine.split(/\s+/);
          snap.totalSystemMB = parseInt(parts[1], 10);
          snap.availableMB = parseInt(parts[6], 10); // 'available' column
        }
      } catch { /* free not available */ }

      // Process memory (single ps call)
      try {
        const psOut = execSync(
          `ps -C node,python,ffmpeg -o comm=,rss= 2>/dev/null`,
          { encoding: 'utf-8', timeout: 5000 },
        );
        const lines = psOut.trim().split('\n').filter(l => l.trim());
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 2) continue;
          const procName = parts[0].trim().toLowerCase();
          const rssMB = Math.round(parseInt(parts[1], 10) / 1024);
          if (rssMB <= 0) continue;

          if (procName === 'node') snap.nodeMB += rssMB;
          else if (procName.startsWith('python')) snap.pythonMB += rssMB;
          else if (procName === 'ffmpeg') snap.ffmpegMB += rssMB;
        }
      } catch { /* ps failed */ }
    }
  } catch {
    // Total failure — return zeroes
  }

  return snap;
}

/**
 * Log current memory snapshot with an optional label.
 */
export function logMemory(label: string = ''): MemorySnapshot {
  const snap = takeSnapshot();
  totalSamples++;

  // Update peaks
  if (snap.nodeMB > peaks.nodeMB) peaks.nodeMB = snap.nodeMB;
  if (snap.pythonMB > peaks.pythonMB) peaks.pythonMB = snap.pythonMB;
  if (snap.ffmpegMB > peaks.ffmpegMB) peaks.ffmpegMB = snap.ffmpegMB;
  if (snap.availableMB < peaks.availableMB || peaks.availableMB === 0) peaks.availableMB = snap.availableMB;
  peaks.totalSystemMB = snap.totalSystemMB;

  const prefix = label ? `[MEMORY:${label}]` : '[MEMORY]';
  // Use the exact format requested by user
  process.stdout.write(`${prefix}\nnode=${snap.nodeMB}MB\npython=${snap.pythonMB}MB\nffmpeg=${snap.ffmpegMB}MB\navailable=${snap.availableMB}MB\n`);
  return snap;
}

/**
 * Log START marker for a pipeline stage.
 */
export function logMemoryStart(label: string): void {
  const snap = takeSnapshot();
  console.log(`[MEMORY START:${label}] node=${snap.nodeMB}MB python=${snap.pythonMB}MB ffmpeg=${snap.ffmpegMB}MB available=${snap.availableMB}MB`);
}

/**
 * Log END marker for a pipeline stage. Updates peaks.
 */
export function logMemoryEnd(label: string): void {
  const snap = takeSnapshot();
  totalSamples++;

  if (snap.nodeMB > peaks.nodeMB) peaks.nodeMB = snap.nodeMB;
  if (snap.pythonMB > peaks.pythonMB) peaks.pythonMB = snap.pythonMB;
  if (snap.ffmpegMB > peaks.ffmpegMB) peaks.ffmpegMB = snap.ffmpegMB;
  if (snap.availableMB < peaks.availableMB || peaks.availableMB === 0) peaks.availableMB = snap.availableMB;
  peaks.totalSystemMB = snap.totalSystemMB;

  console.log(`[MEMORY END:${label}] node=${snap.nodeMB}MB python=${snap.pythonMB}MB ffmpeg=${snap.ffmpegMB}MB available=${snap.availableMB}MB`);
}

/**
 * Print peak usage report.
 */
export function reportPeak(): void {
  console.log(
    `[MEMORY PEAK] ` +
    `node=${peaks.nodeMB}MB ` +
    `python=${peaks.pythonMB}MB ` +
    `ffmpeg=${peaks.ffmpegMB}MB ` +
    `available (lowest)=${peaks.availableMB}MB ` +
    `totalSystem=${peaks.totalSystemMB}MB ` +
    `(${totalSamples} samples)`
  );
}

export function getPeaks(): Readonly<MemorySnapshot> {
  return { ...peaks };
}

// ── Periodic tracking ──

let memInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic memory snapshot logging every `intervalMs` milliseconds.
 */
export function startMemoryTracking(intervalMs: number = 5000): void {
  if (memInterval) {
    clearInterval(memInterval);
  }
  logMemory('tracking START');
  memInterval = setInterval(() => {
    logMemory('tracking');
  }, intervalMs);
}

/**
 * Stop periodic tracking and print peak report.
 */
export function stopMemoryTracking(): void {
  if (memInterval) {
    clearInterval(memInterval);
    memInterval = null;
  }
  logMemory('tracking STOP');
  reportPeak();
}
