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
  InputAccessoryView,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import * as engine from './src/engine';
import { buildGpx } from './src/gpx';
import { startLocationUpdates, stopLocationUpdates } from './src/locationTask';
import {
  LatLng,
  METERS_PER_MILE,
  Route,
  fetchRoute,
  generateLoop,
} from './src/routing';
import { initAudio, isMuted, setMuted, speak } from './src/speech';

/* Volt palette */
const C = {
  ground: '#141513',
  panel: '#1B1D1A',
  panelLine: '#2C2F2A',
  card: '#1D1F1C',
  cardLine: '#33362F',
  btn: '#232622',
  btnLine: '#383C35',
  ink: '#F2F4EE',
  mut: '#9AA095',
  volt: '#C6F432',
  voltText: '#A7CF2B',
  onVolt: '#10120D',
  ice: '#6FCBDE',
  moss: '#55622B',
  stop: '#FF7A6B',
  stopLine: '#6B3B34',
};

const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    carto: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors © CARTO',
    },
  },
  layers: [{ id: 'carto', type: 'raster', source: 'carto' }],
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
    Keyboard.dismiss();
    if (!planning || loopOpen) return;
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
    Keyboard.dismiss();
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

  // Share the recorded run as a GPX file — Garmin Connect and Strava
  // accept it as an activity import.
  async function exportGpx() {
    const trail = engine.getState().trail;
    if (trail.length < 2) {
      Alert.alert('Nothing to export', 'No GPS trail was recorded for this run.');
      return;
    }
    try {
      const date = new Date(trail[0].t);
      const stamp = date.toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const uri = `${FileSystem.cacheDirectory}map-runner-${stamp}.gpx`;
      await FileSystem.writeAsStringAsync(uri, buildGpx(trail, `Map Runner ${date.toLocaleDateString()}`));
      await Sharing.shareAsync(uri, {
        mimeType: 'application/gpx+xml',
        dialogTitle: 'Export run (GPX)',
      });
    } catch (e) {
      Alert.alert('Export failed', String(e));
    }
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
        <Text style={styles.brand}>
          MAP<Text style={{ color: C.volt }}>RUNNER</Text>
        </Text>
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
                paint={{ 'line-color': inRun ? C.moss : C.volt, 'line-width': 5, 'line-opacity': 0.95 }}
              />
            </GeoJSONSource>
          )}
          {run.trail.length > 1 && (
            <GeoJSONSource id="trail" data={lineFeature(run.trail)}>
              <Layer
                id="trail-line"
                type="line"
                paint={{ 'line-color': C.volt, 'line-width': 4, 'line-opacity': 0.95 }}
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
                  'circle-color': C.volt,
                  'circle-stroke-color': C.ground,
                  'circle-stroke-width': 2.5,
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

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.panel}
      >
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
              <Btn label="Locate" onPress={locateMe} />
              <Btn label="Loop…" onPress={() => setLoopOpen(true)} />
              <Btn label="Undo" onPress={undo} />
              <Btn label="Clear" onPress={clearAll} />
            </View>
            <View style={styles.row}>
              <Btn
                label="Test Voice"
                onPress={() => speak('Voice check. Turn-by-turn directions will sound like this.', true)}
              />
              <Btn label="Start Run" primary disabled={!route} onPress={start} />
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
                placeholderTextColor={C.mut}
                autoFocus
                inputAccessoryViewID="loop-done"
              />
              <Btn label="Generate" primary onPress={makeLoop} />
              <Btn
                label="Cancel"
                onPress={() => {
                  Keyboard.dismiss();
                  setLoopOpen(false);
                }}
              />
            </View>
            {Platform.OS === 'ios' && (
              <InputAccessoryView nativeID="loop-done">
                <View style={styles.doneBar}>
                  <Pressable onPress={() => Keyboard.dismiss()} hitSlop={10}>
                    <Text style={styles.doneText}>Done</Text>
                  </Pressable>
                </View>
              </InputAccessoryView>
            )}
          </>
        )}

        {inRun && (
          <>
            <View style={styles.row}>
              <Btn
                label={run.mode === 'paused' ? 'Resume' : 'Pause'}
                onPress={() => engine.pauseResume()}
              />
              <Btn label="Finish" danger onPress={finish} />
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
              <Btn label="Export GPX" onPress={exportGpx} />
              <Btn label="New Route" primary onPress={clearAll} />
            </View>
          </>
        )}
      </KeyboardAvoidingView>
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
      <Text
        style={[
          styles.btnText,
          primary && { color: C.onVolt, fontStyle: 'italic', fontSize: 12.5 },
          danger && { color: C.stop },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.ground },
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  brand: {
    color: C.ink,
    fontWeight: '800',
    fontStyle: 'italic',
    fontSize: 16,
    letterSpacing: 0.5,
  },
  stats: { flexDirection: 'row', gap: 18 },
  statValue: {
    color: C.ink,
    fontSize: 19,
    fontWeight: '800',
    fontStyle: 'italic',
    fontVariant: ['tabular-nums'],
  },
  statLabel: {
    color: C.mut,
    fontSize: 9,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    textAlign: 'center',
  },
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
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.cardLine,
    borderLeftWidth: 4,
    borderLeftColor: C.volt,
    borderRadius: 10,
    padding: 11,
  },
  turnIcon: {
    color: C.onVolt,
    backgroundColor: C.volt,
    fontSize: 22,
    fontWeight: '800',
    minWidth: 38,
    height: 38,
    lineHeight: 38,
    textAlign: 'center',
    borderRadius: 7,
    overflow: 'hidden',
  },
  turnDist: {
    color: C.voltText,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  turnText: { color: C.ink, fontSize: 14, fontWeight: '700' },
  muteBtn: {
    backgroundColor: C.btn,
    borderWidth: 1,
    borderColor: C.btnLine,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  panel: {
    backgroundColor: C.panel,
    borderTopWidth: 1,
    borderTopColor: C.panelLine,
    padding: 15,
    gap: 9,
  },
  hint: { color: C.mut, fontSize: 12, letterSpacing: 0.3, marginBottom: 4 },
  hintSmall: {
    color: C.mut,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: 4,
  },
  summary: {
    color: C.ink,
    fontSize: 15,
    fontWeight: '800',
    fontStyle: 'italic',
    backgroundColor: C.btn,
    borderWidth: 1,
    borderColor: C.cardLine,
    borderLeftWidth: 3,
    borderLeftColor: C.volt,
    borderRadius: 6,
    padding: 12,
    marginBottom: 4,
  },
  row: { flexDirection: 'row', gap: 8 },
  btn: {
    flex: 1,
    backgroundColor: C.btn,
    borderWidth: 1,
    borderColor: C.btnLine,
    borderRadius: 6,
    paddingVertical: 13,
    alignItems: 'center',
  },
  btnPrimary: {
    backgroundColor: C.volt,
    borderColor: C.volt,
    shadowColor: C.volt,
    shadowOpacity: 0.35,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  btnDanger: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: C.stopLine,
  },
  btnText: {
    color: C.ink,
    fontWeight: '800',
    fontSize: 11.5,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  input: {
    width: 76,
    backgroundColor: C.onVolt,
    color: C.ink,
    borderWidth: 1.5,
    borderColor: C.volt,
    borderRadius: 6,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '800',
    fontStyle: 'italic',
    paddingVertical: 11,
  },
  doneBar: {
    backgroundColor: C.panel,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.panelLine,
    alignItems: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  doneText: {
    color: C.volt,
    fontSize: 14,
    fontWeight: '800',
    fontStyle: 'italic',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
});
