import fetch from "node-fetch";

const DISTANCE_M = 50;
const MAX_BEARING_DIFF_SAME_ROAD = 30;
const MAX_BEARING_DIFF_SNAP = 45;
const INITIAL_RADIUS = 50;
const MAX_RADIUS = 300;
const EARTH_RADIUS = 6371e3;


function extrapolate(lat, lon, bearingDeg, distanceMeters) {
  const R = EARTH_RADIUS;
  const reverseBearing = bearingDeg - 180;
  const brng = reverseBearing * Math.PI / 180;
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(distanceMeters / R) +
      Math.cos(lat1) * Math.sin(distanceMeters / R) * Math.cos(brng)
  );

  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(distanceMeters / R) * Math.cos(lat1),
      Math.cos(distanceMeters / R) - Math.sin(lat1) * Math.sin(lat2)
    );

  return {
    lat: lat2 * 180 / Math.PI,
    lon: lon2 * 180 / Math.PI,
  };
}

function bearing(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const λ1 = lon1 * Math.PI / 180, λ2 = lon2 * Math.PI / 180;
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
  const θ = Math.atan2(y, x);
  return ((θ * 180) / Math.PI + 360) % 360;
}

function angleDiff(a, b) {
  let d = ((b - a + 180) % 360) - 180;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}


function getOnewayDirection(way) {
  const t = way.tags || {};
  const oneway = t.oneway;
  const roundabout = t.junction === "roundabout";

  if (roundabout || oneway === "yes" || oneway === "1" || oneway === "true") {
    return { isOneway: true, forward: true, reverse: false };
  }
  if (oneway === "-1" || oneway === "reverse") {
    return { isOneway: true, forward: false, reverse: true };
  }
  return { isOneway: false, forward: true, reverse: true };
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const A = px - ax, B = py - ay;
  const C = bx - ax, D = by - ay;
  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = lenSq !== 0 ? dot / lenSq : -1;
  let xx, yy;

  if (param < 0) { xx = ax; yy = ay; }
  else if (param > 1) { xx = bx; yy = by; }
  else { xx = ax + param * C; yy = ay + param * D; }

  const dx = px - xx, dy = py - yy;
  return { distance: Math.hypot(dx, dy), projection: Math.max(0, Math.min(1, param)) };
}


async function queryWaysAround(lat, lon, radius) {
  const ql = `
    [out:json][timeout:30];
    way(around:${radius},${lat},${lon})[highway];
    out geom tags;
  `.trim();

  const body = `data=${encodeURIComponent(ql)}`;
  const url = "https://overpass-api.de/api/interpreter";

  console.log(`\n[Overpass] QUERY`);
  console.log(`   URL: ${url}`);
  console.log(`   Radius: ${radius}m`);
  console.log(`   Point: ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
  console.log(`   Body: ${body.substring(0, 120)}${body.length > 120 ? '...' : ''}`);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) {
    console.error(`[Overpass] HTTP ${resp.status} ${resp.statusText}`);
    throw new Error(`Overpass ${resp.status}`);
  }

  const data = await resp.json();
  const ways = data.elements.filter(e => e.geometry && e.geometry.length >= 2 && e.tags);

  console.log(`[Overpass] RESPONSE: ${ways.length} valid way(s) found`);
  if (ways.length > 0) {
    const ids = ways.slice(0, 5).map(w => w.id).join(', ');
    console.log(`   First way IDs: ${ids}${ways.length > 5 ? '...' : ''}`);
  }

  return ways;
}


async function snapToNearestRoadWithDirection(
  origLat,
  origLon,
  origBearingDeg,
  distanceMeters = DISTANCE_M,
  startRadius = INITIAL_RADIUS
) {
  // 1. Log input
  console.log(`\n[Input] Original point`);
  console.log(`   Lat: ${origLat.toFixed(6)}`);
  console.log(`   Lon: ${origLon.toFixed(6)}`);
  console.log(`   Bearing: ${origBearingDeg.toFixed(1)}°`);

  // 2. Extrapolate
  const extr = extrapolate(origLat, origLon, origBearingDeg, distanceMeters);
  const extrBearing = bearing(origLat, origLon, extr.lat, extr.lon);
  const bearingChange = Math.abs(angleDiff(origBearingDeg, extrBearing));

  console.log(`[Extrapolation] 50m ahead (reverse bearing)`);
  console.log(`   Extrapolated: ${extr.lat.toFixed(6)}, ${extr.lon.toFixed(6)}`);
  console.log(`   New bearing: ${extrBearing.toFixed(1)}°`);
  console.log(`   Bearing change: ${bearingChange.toFixed(1)}°`);

  // 3. Same-road shortcut
  if (bearingChange <= MAX_BEARING_DIFF_SAME_ROAD) {
    console.log(`[Snap] Bearing change ≤ ${MAX_BEARING_DIFF_SAME_ROAD}° → using extrapolated point (no API)`);
    return {
      lat: extr.lat,
      lon: extr.lon,
      distance: 0,
      wayId: null,
      bearing: extrBearing,
      radiusUsed: 0,
      method: "same_road_no_api",
      oneway: null,
      wayName: null,
    };
  }

  console.log(`[Snap] Bearing change > ${MAX_BEARING_DIFF_SAME_ROAD}° → querying Overpass...`);

  let radius = startRadius;
  let best = null;

  while (radius <= MAX_RADIUS) {
    const ways = await queryWaysAround(extr.lat, extr.lon, radius);
    if (!ways.length) {
      console.log(`   No ways in ${radius}m → increasing radius...`);
      radius = Math.min(MAX_RADIUS, radius * 1.5);
      continue;
    }

    for (const way of ways) {
      const dir = getOnewayDirection(way);
      for (let i = 0; i < way.geometry.length - 1; i++) {
        const a = way.geometry[i];
        const b = way.geometry[i + 1];
        const segBearing = bearing(a.lat, a.lon, b.lat, b.lon);
        const revBearing = (segBearing + 180) % 360;

        const check = (segB, label) => {
          const diff = Math.abs(angleDiff(origBearingDeg, segB));
          if (diff > MAX_BEARING_DIFF_SNAP) return;

          const d = distanceToSegment(extr.lat, extr.lon, a.lat, a.lon, b.lat, b.lon);
          if (!best || d.distance < best.distance) {
            const proj = d.projection;
            best = {
              lat: a.lat + (b.lat - a.lat) * proj,
              lon: a.lon + (b.lon - a.lon) * proj,
              distance: d.distance,
              wayId: way.id,
              bearing: segB,
              radiusUsed: radius,
              method: "overpass_snap",
              oneway: dir.isOneway
                ? (dir.forward && label === 'forward') || (dir.reverse && label === 'reverse')
                  ? label
                  : "reverse"
                : "bidirectional",
              wayName: way.tags.name || way.tags.ref || null,
            };
          }
        };

        if (dir.forward) check(segBearing, 'forward');
        if (dir.reverse) check(revBearing, 'reverse');
      }
    }

    if (best) break;
    radius = Math.min(MAX_RADIUS, radius * 1.5);
  }

  if (!best) {
    console.log(`[Snap] No matching road found in ${MAX_RADIUS}m → using extrapolated point`);
    return {
      lat: extr.lat,
      lon: extr.lon,
      distance: 0,
      wayId: null,
      bearing: extrBearing,
      radiusUsed: 0,
      method: "fallback_extrapolation",
      oneway: null,
      wayName: null,
    };
  }

  console.log(`[Snap] SUCCESS`);
  console.log(`   Way ID: ${best.wayId}`);
  console.log(`   Oneway: ${best.oneway}`);
  console.log(`   Road name: ${best.wayName || '(none)'}`);
  console.log(`   Snapped point: ${best.lat.toFixed(6)}, ${best.lon.toFixed(6)}`);
  console.log(`   Distance from extrapolated: ${best.distance.toFixed(2)}m`);
  console.log(`   Final bearing: ${best.bearing.toFixed(1)}°`);
  console.log(`   Search radius used: ${best.radiusUsed}m`);

  return best;
}

export {
  snapToNearestRoadWithDirection,
  extrapolate,
  bearing,
  angleDiff,
};