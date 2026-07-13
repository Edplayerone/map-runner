/* GPX 1.1 export of a recorded run. Timestamped trackpoints let Garmin
   Connect / Strava import it as an activity (not just a course). */

import { TrailPoint } from './engine';

export function buildGpx(trail: TrailPoint[], name: string): string {
  const pts = trail
    .map(
      (p) =>
        `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}">` +
        `<time>${new Date(p.t).toISOString()}</time></trkpt>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Map Runner"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${name}</name>
    <time>${trail.length ? new Date(trail[0].t).toISOString() : new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${name}</name>
    <type>running</type>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}
