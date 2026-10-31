/** Host measurements use the same UTC epoch microseconds as trace events. */
export interface ResourceSample {
  rec: 'resource';
  id: string;
  recording: string;
  ts: number;
  elapsedMs: number;
  intervalMs: number | null;
  scope: 'host';
  platform: string;
  cpu: { cores: number; busyPercent: number | null; loadAverage: number[] | null };
  memory: { totalBytes: number; freeBytes: number; usedBytes: number };
  network: { interfaces: { name: string; rxBytes: number; txBytes: number; rxBytesPerSecond: number | null; txBytesPerSecond: number | null }[] } | null;
  gpu: { index: number; utilizationPercent: number | null; memoryUsedBytes: number | null; memoryTotalBytes: number | null; temperatureC: number | null; powerWatts: number | null }[] | null;
  pressure?: MemoryPressure | null;
  disk?: DiskActivity | null;
  filesystems?: FilesystemSpace | null;
  processes?: ProcessActivity | null;
  sessionResources?: SessionActivity | null;
  /** Actual observation times for asynchronous counters, never a refreshed timestamp on cached data. */
  observed?: Partial<Record<'network' | 'gpu' | 'pressure' | 'disk' | 'filesystems' | 'processes' | 'sessions', number>>;
  health?: { collectorDurationMs: number; skippedTotal: number };
  unavailable: { metric: 'cpu' | 'network' | 'gpu' | 'pressure' | 'disk' | 'filesystems' | 'processes' | 'sessions'; reason: string }[];
}

export interface SessionBinding {
  session: string; roots: number[];
  /** Verified writer lifetimes, aligned with roots. Present only for automatic discovery. */
  starts?: string[]; discovered?: boolean; shared?: boolean; agent?: string;
}
export type SessionProcess = ProcessActivity['entries'][number] & {
  sessions: string[]; shared?: boolean; cpuPercent: number | null; readBytesPerSecond: number | null; writeBytesPerSecond: number | null;
}
export interface SessionActivity {
  bindings: SessionBinding[];
  entries: SessionProcess[];
  descendants: 'tracked' | 'unavailable'; truncated: boolean; unavailablePids: number[];
  unavailableProcesses?: { pid: number; sessions: string[] }[];
  gpu?: { ts: number; reason: string | null; entries: { pid: number; startId: string; index: number; smPercent: number | null; memoryUsedBytes: number | null }[] };
  network?: { ts: number; reason: string | null; entries: { pid: number; startId: string; rxBytes: number; txBytes: number; rxBytesPerSecond: number | null; txBytesPerSecond: number | null }[] };
}

export interface MemoryPressure {
  availableBytes: number | null; compressedBytes: number | null;
  swapUsedBytes: number | null; swapTotalBytes: number | null;
  swapInPages: number | null; swapOutPages: number | null;
  swapInPagesPerSecond: number | null; swapOutPagesPerSecond: number | null;
  level: 'normal' | 'warning' | 'critical' | null;
  memoryStallSomeUs: number | null; memoryStallFullUs: number | null;
  ioStallSomeUs: number | null; ioStallFullUs: number | null;
}
export interface DiskCounter {
  name: string; readBytes: number | null; writeBytes: number | null;
  readOperations: number | null; writeOperations: number | null;
  transferredBytes: number; transfers: number;
}
export interface DiskActivity {
  intervalMs: number | null;
  devices: (DiskCounter & { readBytesPerSecond: number | null; writeBytesPerSecond: number | null; bytesPerSecond: number | null })[];
}
export interface FilesystemSpace {
  volumes: { path: string; device: string; totalBytes: number; freeBytes: number; availableBytes: number }[];
}
export interface ProcessActivity {
  roots: number[]; descendants: 'tracked' | 'unavailable'; truncated: boolean;
  unavailablePids?: number[];
  entries: { pid: number; parentPid: number; startId: string; cpuTimeUs: number; residentBytes: number;
    readBytes: number | null; writeBytes: number | null }[];
}
export interface RecordingHealth {
  updatedTs: number; samples: number; skipped: number; lastDurationMs: number; effectiveIntervalMs: number;
  lastTs: number | null; lastError: string | null;
}
export interface ResourceRecording {
  rec: 'resource-recording'; id: string; startedTs: number; stoppedTs: number | null;
  context: { hostname: string; platform: string; arch: string; osRelease: string; cpuModel: string;
    gpuModels?: string[];
    logicalCores: number; totalMemoryBytes: number; toolVersion: string; gpuMode: 'auto' | 'off' | 'always';
    rootPids: number[]; sessionBindings?: SessionBinding[]; paths: string[]; cpuLimitCores: number | null; memoryLimitBytes: number | null };
  health: RecordingHealth;
}
