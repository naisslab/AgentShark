import type { ResourceSample, SessionProcess } from './types.ts';

/** Lossless, independent frames. SQL can still inspect bindings without decoding process rows.
 * Captures and the default API keep the original schema; only storage and opt-in clients use this codec. */
export function packResourceSample(sample: ResourceSample) {
  const activity = sample.sessionResources;
  if (!activity?.entries.length) return sample;
  const groups: string[][] = [], groupIds = new Map<string, number>();
  const entries = activity.entries.map((p) => {
    const key = JSON.stringify(p.sessions);
    let group = groupIds.get(key);
    if (group === undefined) { group = groups.length; groups.push(p.sessions); groupIds.set(key, group); }
    return [p.pid, p.parentPid, p.startId, p.cpuTimeUs, p.residentBytes, p.readBytes, p.writeBytes,
      p.cpuPercent, p.readBytesPerSecond, p.writeBytesPerSecond, group, p.shared ?? null];
  });
  return { ...sample, sessionResources: { ...activity, encoding: 'tuples-v1', groups, entries } };
}

export function unpackResourceSample(sample: any): ResourceSample {
  const activity = sample?.sessionResources;
  if (activity?.encoding === undefined) return sample;
  if (activity.encoding !== 'tuples-v1' || !Array.isArray(activity.groups) || activity.groups.length > 128
    || !activity.groups.every((g: unknown) => Array.isArray(g) && g.length <= 64 && g.every((s) => typeof s === 'string'))
    || !Array.isArray(activity.entries) || activity.entries.length > 128) throw new Error('Invalid packed resource sample');
  const entries: SessionProcess[] = activity.entries.map((row: any) => {
    if (!Array.isArray(row) || row.length !== 12 || !Number.isInteger(row[10]) || !activity.groups[row[10]]) throw new Error('Invalid packed process row');
    const [pid, parentPid, startId, cpuTimeUs, residentBytes, readBytes, writeBytes, cpuPercent, readBytesPerSecond, writeBytesPerSecond, group, shared] = row;
    return { pid, parentPid, startId, cpuTimeUs, residentBytes, readBytes, writeBytes, cpuPercent, readBytesPerSecond, writeBytesPerSecond,
      sessions: activity.groups[group], ...(shared === null ? {} : { shared }) };
  });
  const { encoding, groups, ...rest } = activity;
  return { ...sample, sessionResources: { ...rest, entries } };
}

export const parseResourceSample = (json: string): ResourceSample => unpackResourceSample(JSON.parse(json));
