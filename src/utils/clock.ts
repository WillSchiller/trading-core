import { exec } from 'child_process';
import { promisify } from 'util';
import { createChildLogger } from './logger.js';

const execAsync = promisify(exec);
const logger = createChildLogger({ component: 'clock' });

export interface NtpSyncStatus {
  isSynced: boolean;
  service: 'chrony' | 'systemd-timesyncd' | 'ntpd' | 'unknown';
  offsetMs?: number;
  details?: string;
}

export async function checkNtpSync(): Promise<NtpSyncStatus> {
  try {
    const chronyStatus = await checkChrony();
    if (chronyStatus.service !== 'unknown') {
      return chronyStatus;
    }

    const systemdStatus = await checkSystemdTimesyncd();
    if (systemdStatus.service !== 'unknown') {
      return systemdStatus;
    }

    const ntpdStatus = await checkNtpd();
    if (ntpdStatus.service !== 'unknown') {
      return ntpdStatus;
    }

    logger.warn('No NTP service detected');
    return {
      isSynced: false,
      service: 'unknown',
      details: 'No NTP service detected',
    };
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Failed to check NTP sync status');
    return {
      isSynced: false,
      service: 'unknown',
      details: (error as Error).message,
    };
  }
}

async function checkChrony(): Promise<NtpSyncStatus> {
  try {
    const { stdout } = await execAsync('chronyc tracking');
    const lines = stdout.split('\n');

    const offsetLine = lines.find(line => line.includes('System time'));
    if (offsetLine) {
      const match = offsetLine.match(/([\d.]+)\s+seconds\s+(slow|fast)/);
      if (match) {
        const offsetSec = parseFloat(match[1]);
        const offsetMs = match[2] === 'fast' ? offsetSec * 1000 : -offsetSec * 1000;

        return {
          isSynced: Math.abs(offsetMs) < 1000,
          service: 'chrony',
          offsetMs,
          details: `System time offset: ${offsetMs.toFixed(2)}ms`,
        };
      }
    }

    return {
      isSynced: true,
      service: 'chrony',
      details: 'chrony running',
    };
  } catch (error) {
    return { isSynced: false, service: 'unknown' };
  }
}

async function checkSystemdTimesyncd(): Promise<NtpSyncStatus> {
  try {
    const { stdout } = await execAsync('timedatectl status');
    const lines = stdout.split('\n');

    const syncLine = lines.find(line => line.includes('System clock synchronized'));
    const ntpLine = lines.find(line => line.includes('NTP service'));

    if (syncLine || ntpLine) {
      const isSynced = (syncLine?.includes('yes') || ntpLine?.includes('active')) ?? false;

      return {
        isSynced,
        service: 'systemd-timesyncd',
        details: `NTP synchronized: ${isSynced}`,
      };
    }

    return { isSynced: false, service: 'unknown' };
  } catch (error) {
    return { isSynced: false, service: 'unknown' };
  }
}

async function checkNtpd(): Promise<NtpSyncStatus> {
  try {
    const { stdout } = await execAsync('ntpq -p');
    const lines = stdout.split('\n').filter(line => line.trim());

    const syncedPeer = lines.find(line => line.startsWith('*'));

    if (syncedPeer) {
      return {
        isSynced: true,
        service: 'ntpd',
        details: 'ntpd synchronized',
      };
    }

    return {
      isSynced: false,
      service: 'ntpd',
      details: 'ntpd running but not synchronized',
    };
  } catch (error) {
    return { isSynced: false, service: 'unknown' };
  }
}

export interface TimestampValidation {
  isValid: boolean;
  reason?: string;
}

export function validateTimestamps(
  exchangeTsMs: number,
  receivedTsMs: number,
  maxFutureMs = 500,
  maxPastMs = 30000
): TimestampValidation {
  const diff = receivedTsMs - exchangeTsMs;

  if (diff < -maxFutureMs) {
    return {
      isValid: false,
      reason: `future_timestamp: ${Math.abs(diff).toFixed(0)}ms ahead`,
    };
  }

  if (diff > maxPastMs) {
    return {
      isValid: false,
      reason: `ancient_timestamp: ${diff.toFixed(0)}ms old`,
    };
  }

  return { isValid: true };
}
