import fetch from "node-fetch";

// 30.472811, -81.907228 270 

//  INPUT 
const INITIAL_POINT = { lat: 30.472811, lon: -81.907228 };
const BEARING_DEG   = 200;          // degrees (0 degrees = north)
const DISTANCE_M    = 50;            // metres to extrapolate


const MAX_BEARING_DIFF_SAME_ROAD = 30;   // degrees – skip API if change ≤ this
const MAX_BEARING_DIFF_SNAP      = 45;   // degrees – allowed tolerance when snapping
const INITIAL_RADIUS = 50;               // metres – start search radius
const MAX_RADIUS     = 300;              // metres – safety limit
const EARTH_RADIUS   = 6371e3;           // metres



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

  const lon2 = lon1 + Math.atan2(
    Math.sin(brng) * Math.sin(distanceMeters / R) * Math.cos(lat1),
    Math.cos(distanceMeters / R) - Math.sin(lat1) * Math.sin(lat2)
  );

  return {
    lat: lat2 * 180 / Math.PI,
    lon: lon2 * 180 / Math.PI
  };
}


function haversine(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function bearing(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const λ1 = lon1 * Math.PI / 180, λ2 = lon2 * Math.PI / 180;
  const y = Math.sin(λ2-λ1) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(λ2-λ1);
  const θ = Math.atan2(y, x);
  return (θ * 180 / Math.PI + 360) % 360;
}

function angleDiff(a, b) {
  let d = (b - a + 180) % 360 - 180;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}


function getOnewayDirection(way) {
  const t = way.tags || {};
  const oneway = t.oneway;
  const roundabout = t.junction === 'roundabout';

  if (roundabout || oneway === 'yes' || oneway === '1' || oneway === 'true') {
    return { isOneway: true, forward: true, reverse: false };
  }
  if (oneway === '-1' || oneway === 'reverse') {
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
  `;
  const resp = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(ql)}`
  });
  if (!resp.ok) throw new Error(`Overpass ${resp.status}`);
  const data = await resp.json();
  return data.elements.filter(e => e.geometry && e.geometry.length >= 2 && e.tags);
}


async function snapToNearestRoadWithDirection(
  origLat, origLon, origBearingDeg,
  distanceMeters = 50,
  startRadius = INITIAL_RADIUS
) {

  const extr = extrapolate(origLat, origLon, origBearingDeg, distanceMeters);
  const extrBearing = bearing(origLat, origLon, extr.lat, extr.lon);
  const bearingChange = Math.abs(angleDiff(origBearingDeg, extrBearing));


  if (bearingChange <= MAX_BEARING_DIFF_SAME_ROAD) {
    console.log(`Bearing change ${bearingChange.toFixed(1)} degrees → still on same road (no API).`);
    return {
      lat: extr.lat,
      lon: extr.lon,
      distance: 0,
      wayId: null,
      bearing: extrBearing,
      radiusUsed: 0,
      method: "same_road_no_api",
      oneway: null,
      wayName: null
    };
  }

  console.log(`Bearing change ${bearingChange.toFixed(1)} degrees → querying Overpass...`);


  let radius = startRadius;
  let best = null;

  while (radius <= MAX_RADIUS) {
    const ways = await queryWaysAround(extr.lat, extr.lon, radius);
    if (!ways.length) {
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

        if (dir.forward) {
          const diff = Math.abs(angleDiff(origBearingDeg, segBearing));
          if (diff <= MAX_BEARING_DIFF_SNAP) {
            const d = distanceToSegment(extr.lat, extr.lon, a.lat, a.lon, b.lat, b.lon);
            if (!best || d.distance < best.distance) {
              const proj = d.projection;
              best = {
                lat: a.lat + (b.lat - a.lat) * proj,
                lon: a.lon + (b.lon - a.lon) * proj,
                distance: d.distance,
                wayId: way.id,
                bearing: segBearing,
                radiusUsed: radius,
                method: "overpass_snap",
                oneway: dir.isOneway ? (dir.forward ? "forward" : "reverse") : "bidirectional",
                wayName: way.tags.name || way.tags.ref || null
              };
            }
          }
        }

        if (dir.reverse) {
          const diff = Math.abs(angleDiff(origBearingDeg, revBearing));
          if (diff <= MAX_BEARING_DIFF_SNAP) {
            const d = distanceToSegment(extr.lat, extr.lon, a.lat, a.lon, b.lat, b.lon);
            if (!best || d.distance < best.distance) {
              const proj = d.projection;
              best = {
                lat: a.lat + (b.lat - a.lat) * proj,
                lon: a.lon + (b.lon - a.lon) * proj,
                distance: d.distance,
                wayId: way.id,
                bearing: revBearing,
                radiusUsed: radius,
                method: "overpass_snap",
                oneway: "reverse",
                wayName: way.tags.name || way.tags.ref || null
              };
            }
          }
        }
      }
    }

    if (best) break;               // found a good segment
    radius = Math.min(MAX_RADIUS, radius * 1.5);
  }

  if (!best) {
    console.log("No road segment matching direction (one-way aware) found.");
    return null;
  }

  console.log(`Snapped to way ${best.wayId} [${best.oneway}] – bearing ${best.bearing.toFixed(1)} degrees`);
  return best;
}


(async () => {
  console.log(`Starting extrapolation from (${INITIAL_POINT.lat}, ${INITIAL_POINT.lon})...`);
  const extrapolated = extrapolate(INITIAL_POINT.lat, INITIAL_POINT.lon, BEARING_DEG, DISTANCE_M);
  console.log(`Extrapolated point: ${extrapolated.lat.toFixed(6)}, ${extrapolated.lon.toFixed(6)}`);

  const snapped = await snapToNearestRoadWithDirection(
    INITIAL_POINT.lat,
    INITIAL_POINT.lon,
    BEARING_DEG,
    DISTANCE_M,
    INITIAL_RADIUS
  );

  if (snapped) {
    if (snapped.method === "same_road_no_api") {
      console.log(`Same-road shortcut – using extrapolated point directly.`);
    } else {
      console.log(`Snapped to nearest road: ${snapped.lat.toFixed(6)}, ${snapped.lon.toFixed(6)}`);
      console.log(`Distance from extrapolated: ${snapped.distance.toFixed(2)} meters`);
      console.log(`Road bearing: ${snapped.bearing.toFixed(1)} degrees  (oneway: ${snapped.oneway})`);
      if (snapped.wayName) console.log(`Road name/ref: ${snapped.wayName}`);
    }
  } else {
    console.log("No nearby road found for snapping.");
  }
})();