/* Background location task. Defined at module scope (imported from index.ts)
   so the OS can wake it while the app is backgrounded or the screen is
   locked. Every fix is fed to the RunEngine, which speaks the guidance. */

import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { onLocation } from './engine';

export const LOCATION_TASK = 'map-runner-location';

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(
  LOCATION_TASK,
  async ({ data, error }) => {
    if (error || !data?.locations) return;
    for (const loc of data.locations) {
      onLocation(loc.coords.latitude, loc.coords.longitude, loc.coords.accuracy ?? null);
    }
  },
);

export async function startLocationUpdates(): Promise<void> {
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.BestForNavigation,
    activityType: Location.ActivityType.Fitness,
    timeInterval: 1000,
    distanceInterval: 2,
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
    foregroundService: {
      notificationTitle: 'Map Runner is guiding your run',
      notificationBody: 'Voice directions and GPS recording are active.',
      notificationColor: '#10b981',
    },
  });
}

export async function stopLocationUpdates(): Promise<void> {
  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
}
