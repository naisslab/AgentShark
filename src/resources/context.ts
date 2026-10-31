import { readFileSync } from 'node:fs';
import { readFile as readText, readdir } from 'node:fs/promises';
import { arch, cpus, hostname, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import type { SamplerOptions } from './sampler.ts';
import type { ResourceRecording } from './types.ts';

export async function recordingContext(options: SamplerOptions): Promise<ResourceRecording['context']> {
  let cpuLimitCores: number | null = null, memoryLimitBytes: number | null = null;
  let gpuModels: string[] = [];
  if (process.platform === 'linux') {
    const group = /^0::(.*)$/m.exec(await readText('/proc/self/cgroup', 'utf8').catch(() => ''))?.[1];
    if (group && !group.split('/').includes('..')) {
      const base = resolve('/sys/fs/cgroup', '.' + group);
      const [cpu, memory] = await Promise.all([readText(`${base}/cpu.max`, 'utf8').catch(() => ''), readText(`${base}/memory.max`, 'utf8').catch(() => '')]);
      const [quota, period] = cpu.trim().split(/\s+/).map(Number);
      if (quota > 0 && period > 0) cpuLimitCores = quota / period;
      if (/^\d+$/.test(memory.trim())) memoryLimitBytes = Number(memory.trim());
    }
    if (options.gpuMode !== 'off') {
      const base = '/sys/bus/pci/drivers/nvidia';
      const devices = (await readdir(base).catch(() => [])).filter((s) => /^[\da-f]{4}:[\da-f]{2}:[\da-f]{2}\.[0-7]$/i.test(s)).slice(0, 32);
      gpuModels = await Promise.all(devices.map(async (d) => {
        const [vendor, model] = await Promise.all([readText(`${base}/${d}/vendor`, 'utf8').catch(() => ''), readText(`${base}/${d}/device`, 'utf8').catch(() => '')]);
        return /^0x[\da-f]+$/i.test(vendor.trim()) && /^0x[\da-f]+$/i.test(model.trim()) ? `pci:${vendor.trim()}:${model.trim()}` : 'unknown';
      }));
    }
  }
  const cores = cpus();
  return { hostname: hostname(), platform: process.platform, arch: arch(), osRelease: release(), cpuModel: cores[0]?.model ?? 'unknown',
    logicalCores: cores.length, totalMemoryBytes: totalmem(), gpuModels, toolVersion: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version,
    gpuMode: options.gpuMode ?? 'auto', rootPids: options.pids ?? [], sessionBindings: options.sessions ?? [], paths: options.paths ?? [process.cwd()], cpuLimitCores, memoryLimitBytes };
}
