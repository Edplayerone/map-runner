import {
  Camera,
  type CameraRef,
  GeoJSONSource,
  Layer,
  Map as MapLibreMap,
  type StyleSpecification,
  UserLocation,
} from '@maplibre/maplibre-react-native';
import { useKeepAwake } from 'expo-keep-awake';
import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import * as engine from './src/engine';
import { startLocationUpdates, stopLocationUpdates } from './src/locationTask';
import {
  LatLng,
  METERS_PER_MILE,
  Route,
  fetchRoute,
  generateLoop,
} from './src/routing';
import { initAudio, isMuted, setMuted, speak } from './src/speech';

const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

const TURN_ICONS: Record<number, string> = {
  8: '↑', 9: '↗', 10: '→', 11: '↘', 12: '↩', 13: '↪', 14: '↙', 15: '←', 16: '↖',
  17: '↑', 18: '→', 19: '↑', 20: '←', 21: '↩', 22: '↑', 23: '↗', 24: '↖',
  26: '⟳', 27: '⟲', 4: '🏁', 5: '🏁', 6: '🏁',
};

function fmtTime(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtPace(secPerMile: number): string {
  if (!isFinite(secPerMile) || secPerMile <= 0 || secPerMile > 3600) return '–:––';
  const m = Math.floor(secPerMile / 60);
  const s = Math.round(secPerMile % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const lineFeature = (pts: LatLng[]) => ({
  type: 'Feature' as const,
  properties: {},
  geometry: {
    type: 'LineString' as const,
    coordinates: pts.map((p) => [p.lng, p.lat]),
  },
});

const pointsFeature = (pts: LatLng[]) => ({
  type: 'FeatureCollection' as const,
  features: pts.map((p) => ({
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
  })),
});

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}

function Main() {
  useKeepAwake();
  const run = useSyncExternalStore(engine.subscribe, engine.getState);
  const [, forceTick] = useState(0);
  const [waypoints, setWaypoints] = useState<LatLng[]>([]);
  const [route, setRoute] = useState<Route | null>(null);
  const [routing, setRouting] = useState(false);
  const [loopOpen, setLoopOpen] = useState(false);
  const [loopMiles, setLoopMiles] = useState('3');
  const [mutedUi, setMutedUi] = useState(false);
  const [summary, setSummary] = useState<{ miles: number; seconds: number } | null>(null);
  const cameraRef = useRef<CameraRef>(null);

  // 1 Hz re-render so the timer ticks while running
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    (async () => {
      await initAudio();
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const pos = await Location.getCurrentPositionAsync({}).catch(() => null);
        if (pos) {
          cameraRef.current?.jumpTo({
            center: [pos.coords.longitude, pos.coords.latitude],
            zoom: 15,
          });
        }
      }
    })();
  }, []);

  // follow the runner on the map
  useEffect(() => {
    if (run.mode === 'running' && run.here) {
      cameraRef.current?.easeTo({
        center: [run.here.lng, run.here.lat],
        duration: 500,
      });
    }
  }, [run.here, run.mode]);

  const planning = run.mode === 'plan' && !summary;

  async function routeThrough(pts: LatLng[]) {
    if (pts.length < 2) {
      setRoute(null);
      return;
    }
    setRouting(true);
    try {
      setRoute(await fetchRoute(pts));
    } catch {
      Alert.alert('No route', 'Could not find a runnable route between those points.');
    } finally {
      setRouting(false);
    }
  }

  function onMapPress(lngLat: [number, number]) {
    if (!planning) return;
    const [lng, lat] = lngLat;
    const next = [...waypoints, { lat, lng }];
    setWaypoints(next);
    routeThrough(next);
  }

  function undo() {
    const next = waypoints.slice(0, -1);
    setWaypoints(next);
    routeThrough(next);
  }

  function clearAll() {
    setWaypoints([]);
    setRoute(null);
    setSummary(null);
    engine.reset();
  }

  async function locateMe() {
    const pos = await Location.getCurrentPositionAsync({}).catch(() => null);
    if (!pos) {
      Alert.alert('Location unavailable', 'Allow location access in Settings.');
      return;
    }
    cameraRef.current?.easeTo({
      center: [pos.coords.longitude, pos.coords.latitude],
      zoom: 15,
      duration: 400,
    });
  }

  async function makeLoop() {
    const miles = parseFloat(loopMiles);
    if (!miles || miles <= 0) return;
    setLoopOpen(false);
    setRouting(true);
    try {
      const pos = await Location.getCurrentPositionAsync({}).catch(() => null);
      if (!pos) throw new Error('no location');
      const origin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const result = await generateLoop(origin, miles);
      setWaypoints(result.waypoints);
      setRoute(result.route);
    } catch {
      Alert.alert('No loop', 'Could not build a loop here — try drawing a route instead.');
    } finally {
      setRouting(false);
    }
  }

  async function start() {
    if (!route) return;
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') {
      Alert.alert('Location needed', 'Allow location access to start a run.');
      return;
    }
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') {
      Alert.alert(
        'Heads up',
        'Background location was not granted — directions will only speak while the app is open. ' +
          'For guidance with the screen locked, allow "Always" location for Map Runner in Settings.',
      );
    }
    setSummary(null);
    engine.startRun(route);
    await startLocationUpdates();
  }

  async function finish() {
    await stopLocationUpdates();
    setSummary(engine.finishRun());
  }

  function toggleMute() {
    setMuted(!isMuted());
    setMutedUi(isMuted());
  }

  const miles = run.traveled / METERS_PER_MILE;
  const sec = engine.elapsedSec();
  const nextM = run.route?.maneuvers[run.nextManeuverIdx];
  const inRun = run.mode === 'running' || run.mode === 'paused';

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <StatusBar style="light" />
      <View style={styles.topbar}>
        <Text style={styles.brand}>🏃 Map Runner</Text>
        {inRun && (
          <View style={styles.stats}>
            <Stat value={miles.toFixed(2)} label="mi" />
            <Stat value={fmtTime(sec)} label="time" />
            <Stat value={fmtPace(miles > 0.02 ? sec / miles : NaN)} label="/mi" />
          </View>
        )}
      </View>

      <View style={styles.mapWrap}>
        <MapLibreMap
          style={styles.map}
          mapStyle={OSM_STYLE}
          onPress={(e) => onMapPress(e.nativeEvent.lngLat)}
        >
          <Camera ref={cameraRef} />
          <UserLocation />
          {route && (
            <GeoJSONSource id="route" data={lineFeature(route.shape)}>
              <Layer
                id="route-line"
                type="line"
                paint={{ 'line-color': '#10b981', 'line-width': 5, 'line-opacity': 0.9 }}
              />
            </GeoJSONSource>
          )}
          {run.trail.length > 1 && (
            <GeoJSONSource id="trail" data={lineFeature(run.trail)}>
              <Layer
                id="trail-line"
                type="line"
                paint={{ 'line-color': '#3b82f6', 'line-width': 4, 'line-opacity': 0.9 }}
              />
            </GeoJSONSource>
          )}
          {waypoints.length > 0 && (
            <GeoJSONSource id="wps" data={pointsFeature(waypoints)}>
              <Layer
                id="wp-circles"
                type="circle"
                paint={{
                  'circle-radius': 6,
                  'circle-color': '#10b981',
                  'circle-stroke-color': '#ffffff',
                  'circle-stroke-width': 2,
                }}
              />
            </GeoJSONSource>
          )}
        </MapLibreMap>

        {inRun && (
          <View style={styles.turnCard}>
            <Text style={styles.turnIcon}>
              {run.arrived ? '🏁' : run.offRoute ? '⚠' : nextM ? TURN_ICONS[nextM.type] || '•' : '•'}
            </Text>
            <View style={{ flex: 1 }}>
              {run.distToTurn != null && !run.arrived && (
                <Text style={styles.turnDist}>
                  in {Math.round((run.distToTurn * 3.28084) / 10) * 10} ft
                </Text>
              )}
              <Text style={styles.turnText}>
                {run.arrived
                  ? 'Route complete!'
                  : run.offRoute
                  ? 'Off route — return to the green path'
                  : nextM?.instruction ?? 'Follow the route'}
              </Text>
            </View>
            <Pressable style={styles.muteBtn} onPress={toggleMute}>
              <Text style={styles.btnText}>{mutedUi ? '🔇' : '🔊'}</Text>
            </Pressable>
          </View>
        )}
      </View>

      <View style={styles.panel}>
        {planning && !loopOpen && (
          <>
            <Text style={styles.hint}>
              {routing
                ? 'Routing…'
                : route
                ? `Route: ${(route.totalMeters / METERS_PER_MILE).toFixed(2)} mi`
                : 'Tap the map to drop route points — the path snaps to runnable roads & trails.'}
            </Text>
            <View style={styles.row}>
              <Btn label="📍 Locate" onPress={locateMe} />
              <Btn label="🔀 Loop…" onPress={() => setLoopOpen(true)} />
              <Btn label="↩ Undo" onPress={undo} />
              <Btn label="✕ Clear" onPress={clearAll} />
            </View>
            <View style={styles.row}>
              <Btn
                label="🔈 Test voice"
                onPress={() => speak('Voice check. Turn-by-turn directions will sound like this.', true)}
              />
              <Btn label="▶ Start Run" primary disabled={!route} onPress={start} />
            </View>
          </>
        )}

        {planning && loopOpen && (
          <>
            <Text style={styles.hint}>Generate a random loop from your location. How many miles?</Text>
            <View style={styles.row}>
              <TextInput
                style={styles.input}
                value={loopMiles}
                onChangeText={setLoopMiles}
                keyboardType="decimal-pad"
                placeholderTextColor="#9ca3af"
              />
              <Btn label="Generate" primary onPress={makeLoop} />
              <Btn label="Cancel" onPress={() => setLoopOpen(false)} />
            </View>
          </>
        )}

        {inRun && (
          <>
            <View style={styles.row}>
              <Btn
                label={run.mode === 'paused' ? '▶ Resume' : '⏸ Pause'}
                onPress={() => engine.pauseResume()}
              />
              <Btn label="■ Finish" danger onPress={finish} />
            </View>
            <Text style={styles.hintSmall}>
              Voice keeps guiding with the screen locked or another app open.
            </Text>
          </>
        )}

        {summary && (
          <>
            <Text style={styles.summary}>
              🏁 {summary.miles.toFixed(2)} mi in {fmtTime(summary.seconds)}
              {summary.miles > 0.02
                ? ` · ${fmtPace(summary.seconds / summary.miles)} /mi`
                : ''}
            </Text>
            <View style={styles.row}>
              <Btn label="＋ New route" primary onPress={clearAll} />
            </View>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={{ alignItems: 'center' }}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Btn({
  label,
  onPress,
  primary,
  danger,
  disabled,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        primary && styles.btnPrimary,
        danger && styles.btnDanger,
        disabled && { opacity: 0.4 },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text style={[styles.btnText, primary && { color: '#052e22' }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111827' },
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  brand: { color: '#f9fafb', fontWeight: '700', fontSize: 16 },
  stats: { flexDirection: 'row', gap: 16 },
  statValue: { color: '#f9fafb', fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  statLabel: { color: '#9ca3af', fontSize: 10, textTransform: 'uppercase' },
  mapWrap: { flex: 1 },
  map: { flex: 1 },
  turnCard: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#065f46',
    borderRadius: 14,
    padding: 12,
  },
  turnIcon: { color: '#f9fafb', fontSize: 30, fontWeight: '700', minWidth: 36, textAlign: 'center' },
  turnDist: { color: '#a7f3d0', fontSize: 12 },
  turnText: { color: '#f9fafb', fontSize: 15, fontWeight: '600' },
  muteBtn: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  panel: { backgroundColor: '#1f2937', padding: 14, gap: 8 },
  hint: { color: '#9ca3af', fontSize: 13, marginBottom: 4 },
  hintSmall: { color: '#9ca3af', fontSize: 12, marginTop: 4 },
  summary: {
    color: '#f9fafb',
    fontSize: 15,
    backgroundColor: '#111827',
    borderRadius: 10,
    padding: 12,
    marginBottom: 4,
  },
  row: { flexDirection: 'row', gap: 8 },
  btn: {
    flex: 1,
    backgroundColor: '#374151',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  btnPrimary: { backgroundColor: '#10b981' },
  btnDanger: { backgroundColor: '#dc2626' },
  btnText: { color: '#f9fafb', fontWeight: '600', fontSize: 13 },
  input: {
    width: 80,
    backgroundColor: '#111827',
    color: '#f9fafb',
    borderRadius: 12,
    textAlign: 'center',
    fontSize: 16,
    paddingVertical: 10,
  },
});
