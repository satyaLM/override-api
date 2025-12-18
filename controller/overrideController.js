// overrideHandler.js
import overrideDao from '../dao/overrideDao.js';
import logger from '../logger.js';
import { snapToNearestRoadWithDirection, extrapolate } from '../snap_to_road.js';

function now() {
  return new Date().toISOString();
}

class OverrideHandler {
  async createClusterOverride(req, res) {
    const start = Date.now();
    const clusterObjs = req.body.cluster_ids || [];
    const detailed = !!req.body.detailed;  

    logger.info(`[${now()}] [CLUSTER] Request received → ${clusterObjs.length} IDs`);
    logger.access(`[${now()}] [CLUSTER] Request received → ${clusterObjs.length} IDs`);

    try {
      if (!Array.isArray(clusterObjs) || clusterObjs.length === 0) {
        return res.send(400, {
          success: false,
          error: "cluster_ids must be a non-empty array"
        });
      }

      const validationErrors = [];
      for (const item of clusterObjs) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          validationErrors.push("Each item in cluster_ids must be an object");
          continue;
        }
        if (!item.cluster_id) {
          validationErrors.push("Missing cluster_id in one of the items");
          continue;
        }
        const id = item.cluster_id;
        if (item.type !== undefined && item.type !== "OVERRIDE_VALUE") {
          validationErrors.push(`For cluster_id ${id}, type must be "OVERRIDE_VALUE" if provided, got "${item.type}"`);
        }
      }

      if (validationErrors.length > 0) {
        return res.send(400, {
          success: false,
          error: "Invalid cluster_ids format",
          details: validationErrors
        });
      }

      logger.info(`[${now()}] [CLUSTER] Fetching DB batch data...`);
      const dbResult = await overrideDao.getBatchClusterData(clusterObjs);
      const row = dbResult[0];
      const {
        processed_count = 0,
        failed_count = 0,
        failed_ids = [],
        skipped_count = 0,
        skipped_ids = [],
        cluster_data = []
      } = row || {};

      if (processed_count === 0) {
        logger.warn(`[${now()}] [CLUSTER] No valid clusters found`);
        logger.access(`[${now()}] [CLUSTER] No valid clusters found`);

        const details = clusterObjs.map(c => {
          const id = c.cluster_id;
          if (failed_ids.includes(id)) return `Cluster ${id} not found or invalid`;
          if (skipped_ids.includes(id)) return `Cluster ${id} skipped (already have active override)`;
          return `Cluster ${id} not processed`;
        });
        res.send(200, {
          success: true,
          message: "No valid clusters to process",
          processed_count: 0,
          failed_count,
          failed_ids,
          skipped_count,
          skipped_ids,
          details
        });
      }

      logger.info(`[${now()}] [CLUSTER] Running snap-to-road for ${cluster_data.length} clusters`);
      const snapped = await Promise.all(cluster_data.map(async (d) => {
        const snapStart = Date.now();
        try {
          const snap = await snapToNearestRoadWithDirection({
            cluster_id: d.cluster_id,
            lat: d.lat,
            lon: d.lon,
            bearing: d.bearing,
            country_code_iso3: d.country_code_iso3 || 'IND'
          });
          logger.info(
            `[${now()}] [CLUSTER] Snap done for ${d.cluster_id} (${Date.now() - snapStart}ms)`
          );
          return {
            ...d,
            ...snap,
            method: "snapped",
            status: "success",
            message: `Created override for cluster id : ${d.cluster_id} and inserted successfully`
          };
        } catch (err) {
          logger.error(`[${now()}] [CLUSTER] Snap FAILED for ${d.cluster_id}:`, err);
          return {
            ...d,
            method: "snap_failed",
            status: "failed",
            message: `Cluster ${d.cluster_id} snap failed: ${err.message}`
          };
        }
      }));

      const toInsert = snapped.filter(r => r.method === "snapped");
      const snapFailed = snapped.filter(r => r.method === "snap_failed");

      if (toInsert.length > 0) {
        logger.info(`[${now()}] [CLUSTER] Preparing DB insert for ${toInsert.length} rows`);
        logger.access(`[${now()}] [CLUSTER] Preparing DB insert for ${toInsert.length} rows`);
        const insertRows = toInsert.map(r => ({
          cluster_id: r.cluster_id,
          lat: r.lat,
          lon: r.lon,
          bearing: r.bearing,
          accuracy: r.accuracy,
          speed_limit_read_by_engine: r.speed_limit_read_by_engine,
          override_type: r.override_type || "OVERRIDE",
          override_value: r.override_value ?? null,
          expected_speed_sign_board_value: r.override_value ? null : r.speed_limit_read_by_engine,
          src: "MANUAL"
        }));
        await overrideDao.writeBatchOverrides(insertRows);
        logger.info(`[${now()}] [CLUSTER] Insert to DB completed`);
        logger.access(`[${now()}] [CLUSTER] Insert to DB completed`);
      } else {
        logger.info(`[${now()}] [CLUSTER] No rows to insert`);
        logger.access(`[${now()}] [CLUSTER] No rows to insert`);
      }


      const details = clusterObjs.map(c => {
        const id = c.cluster_id;
        const match = snapped.find(r => r.cluster_id === id);

        if (!match) {
          const baseMsg = `Cluster ${id} not processed`;
          return detailed
            ? { cluster_id: id, status: "not_found", message: baseMsg }
            : baseMsg;
        }

        if (match.method === "snap_failed") {
          const baseMsg = match.message;
          return detailed
            ? {
              ...match,
              cluster_id: id,
              status: "failed",
              message: baseMsg
            }
            : baseMsg;
        }

        const baseMsg = `Created override for cluster id: ${id} and inserted successfully`;

        if (detailed) {
          return {
            ...match,
            cluster_id: id,
            status: "success",
            message: baseMsg,
            original: {
              lat: match.original_lat || match.lat,
              lon: match.original_lon || match.lon,
              bearing: match.bearing,
              speed_limit: match.speed_limit_read_by_engine,
              override_value: match.override_value
            },
            final_inserted: {
              lat: match.lat,
              lon: match.lon
            },
            snapped: {
              lat: match.lat || null,
              lon: match.lon || null,
              way_id: match.way_id,
              way_name: match.way_name
            },
            inserted: true
          };
        }

        return baseMsg;
      });

      res.send(200, {
        success: true,
        message: `Batch override completed – ${toInsert.length} processed, ${snapFailed.length} failed, ${skipped_count} skipped`,
        summary: {
          total_requested: clusterObjs.length,
          processed_count: toInsert.length,
          failed_count: snapFailed.length,
          skipped_count,
          processed_ids: toInsert.map(r => r.cluster_id),
          skipped_ids,
          failed_ids: snapFailed.map(r => r.cluster_id)
        },
        details
      });
    } catch (err) {
      logger.error(`[${now()}] [CLUSTER] ERROR`, err);
      logger.access(`[${now()}] [CLUSTER] ERROR`, err);
      return res.send(500, { success: false, message: err.message });
    }
  }

  async createAdasOverride(req, res) {
    const start = Date.now();
    const point_ids = req.body.point_ids || [];
    const detailed = !!req.body.detailed;  

    logger.info(`[${now()}] [ADAS] Request received → ${point_ids.length} points`);
    logger.access(`[${now()}] [ADAS] Request received → ${point_ids.length} points`);

    try {
      if (!Array.isArray(point_ids) || point_ids.length === 0) {
        return res.send(400, {
          success: false,
          error: "point_ids must be a non-empty array"
        });
      }

      const validationErrors = [];
      point_ids.forEach(item => {
        if (item.type !== undefined && item.type !== "OVERRIDE_VALUE") {
          const id = item.point_id || item.id || '(unknown id)';
          validationErrors.push(`For point ${id}, type must be "OVERRIDE_VALUE" if provided, got "${item.type}"`);
        }
      });

      if (validationErrors.length > 0) {
        return res.send(400, {
          success: false,
          error: "Invalid type value in one or more items",
          details: validationErrors
        });
      }

      point_ids.forEach(p => {
        if (p["OVERRIDE_VALUE"] !== undefined) {
          p.override_value = p["OVERRIDE_VALUE"];
        }
      });

      logger.info(`[${now()}] [ADAS] Fetching DB batch data...`);
      const dbResult = await overrideDao.getBatchViolationData(point_ids);
      const row = dbResult[0];

      if (!row || row.processed_count === 0) {
        logger.warn(`[${now()}] [ADAS] No valid violation points found`);
        logger.access(`[${now()}] [ADAS] No valid violation points found`);
        const details = point_ids.map(p => {
          const fullPointKey = p.tsp_name.startsWith("trips_")
            ? `${p.tsp_name}::${p.trip_id}::${p.event_index}`
            : `trips_${p.tsp_name}::${p.trip_id}::${p.event_index}`;
          const baseMsg = `Point id: ${fullPointKey} not processed`;
          return detailed ? { point_id: fullPointKey, status: "not_found", message: baseMsg } : baseMsg;
        });
        return res.send(200, {
          success: true,
          message:
            row?.skipped_count > 0
              ? `All ${row.skipped_count} points already have ACTIVE overrides`
              : "No valid points to process",
          processed_count: 0,
          skipped_count: row?.skipped_count || 0,
          failed_count: row?.failed_count || 0,
          details
        });
      }

      const { violation_data } = row;

      const snapped = await Promise.all(
        violation_data.map(async (v) => {
          const snapStart = Date.now();
          const countryCode = v.sign;
          try {
            const snap = await snapToNearestRoadWithDirection({
              cluster_id: v.point_key,
              lat: v.lat,
              lon: v.lon,
              bearing: v.bearing,
              country_code_iso3: countryCode
            });
            return {
              ...v,
              ...snap,
              point_trip_id: v.trip_id,
              point_event_index: v.event_index,
              point_id: v.violation_id,
              override_value: v.override_value,
              snap_message: snap.message,
              used_country_code: countryCode,
              method: "snapped",
              status: "success"
            };
          } catch (err) {
            logger.error(
              `[${now()}] [ADAS] Snap FAILED for point id: ${v.point_key}:`,
              err
            );
            logger.access(`[${now()}] [ADAS] Snap FAILED for point id: ${v.point_key}:`, err);
            return {
              ...v,
              point_trip_id: v.trip_id,
              point_event_index: v.event_index,
              point_id: v.violation_id,
              method: "snap_failed",
              status: "failed",
              message: `Point id: ${v.point_key} snap failed (country: ${countryCode}): ${err.message}`
            };
          }
        })
      );

      const results = await Promise.all(
        snapped.map(async (r) => {
          if (r.method === "snap_failed") return r;
          const dupStart = Date.now();
          const dup = await overrideDao.checkAdasDuplicate(
            r.lat,
            r.lon,
            r.bearing,
            r.speed_limit_read_by_engine
          );
          if (dup.duplicate) {
            return {
              ...r,
              method: "duplicate_skipped",
              status: "skipped",
              message: `Point id: ${r.point_key} skipped — ACTIVE override exists (ID: ${dup.existing_id})`
            };
          }
          return {
            ...r,
            method: "ready_to_insert",
            status: "success",
            message: `Created override for Point id: ${r.point_key} and inserted successfully`
          };
        })
      );

      const toInsert = results.filter(r => r.method === "ready_to_insert");
      const skipped = results.filter(r => r.method === "duplicate_skipped");
      const snapFailed = results.filter(r => r.method === "snap_failed");

      if (toInsert.length > 0) {
        logger.info(
          `[${now()}] [ADAS] Inserting ${toInsert.length} new overrides to DB...`
        );
        logger.access(`[${now()}] [ADAS] Inserting ${toInsert.length} new overrides to DB...`);
        const insertRows = toInsert.map(r => ({
          violation_id: r.violation_id,
          lat: r.lat,
          lon: r.lon,
          bearing: r.bearing,
          accuracy: r.accuracy,
          speed_limit_read_by_engine: r.speed_limit_read_by_engine,
          override_type: r.override_type,
          override_speed_sign_board_value: r.override_value ?? null,
          expected_speed_sign_board_value: r.override_value ? null : r.expected_value ?? null
        }));
        await overrideDao.writeAdasOverrides(insertRows);
        logger.info(`[${now()}] [ADAS] Insert completed`);
        logger.access(`[${now()}] [ADAS] Insert completed`);
      } else {
        logger.info(`[${now()}] [ADAS] No inserts needed`);
        logger.access(`[${now()}] [ADAS] No inserts needed`);
      }

      const details = point_ids.map(p => {
        const fullPointKey = p.tsp_name.startsWith("trips_")
          ? `${p.tsp_name}::${p.trip_id}::${p.event_index}`
          : `trips_${p.tsp_name}::${p.trip_id}::${p.event_index}`;
        const match = results.find(r =>
          r.point_trip_id === p.trip_id &&
          r.point_event_index === p.event_index
        );
        if (!match) {
          const baseMsg = `Point id: ${fullPointKey} not found or invalid`;
          return detailed ? { point_id: fullPointKey, status: "not_found", message: baseMsg } : baseMsg;
        }
        if (detailed) {
          return {
            ...match,
            point_id: fullPointKey,
            original: {
              lat: match.original_lat,
              lon: match.original_lon,
              bearing: match.bearing,
              speed_limit: match.speed_limit_read_by_engine,
              override_value: match.override_value
            },
            final_inserted: {
              lat: match.lat,
              lon: match.lon
            },
            inserted: match.method === "ready_to_insert"
          };
        }
        return match.message;
      });

      res.send(200, {
        success: toInsert.length > 0,
        message:
          toInsert.length > 0
            ? `Insert success — ${toInsert.length} new overrides created`
            : `All ${skipped.length} points already have ACTIVE overrides`,
        processed_count: toInsert.length,
        skipped_count: skipped.length + (row.skipped_count || 0),
        failed_count: snapFailed.length + (row.failed_count || 0),
        details
      });
    } catch (err) {
      logger.error(`[${now()}] [ADAS] ERROR`, err.stack || err);
      logger.access(`[${now()}] [ADAS] ERROR`, err.stack || err);
      return res.send(500, { success: false, error: err.message });
    }
  }

  async createStopOverride(req, res) {
    const detailed = !!req.body.detailed; 
    let pointObjs = req.body.point_ids || [];

    logger.info(`[${now()}] [STOP] Request → ${pointObjs.length} points`);
    logger.access(`[${now()}] [STOP] Request → ${pointObjs.length} points`);

    try {
      if (!Array.isArray(pointObjs) || pointObjs.length === 0) {
        return res.send(400, {
          success: false,
          message: "point_ids must be non-empty array"
        });
      }

      const dbResult = await overrideDao.getStopSignData(pointObjs);

      let processed_count = 0;
      let skipped_count = 0;
      let failed_count = 0;
      const details = [];

      if (!dbResult || dbResult.length === 0 || !dbResult[0].stop_data || dbResult[0].stop_data.length === 0) {
        pointObjs.forEach(p => {
          const fullPointKey = p.tsp_name.startsWith("trips_")
            ? `${p.tsp_name}::${p.trip_id}::${p.event_index}`
            : `trips_${p.tsp_name}::${p.trip_id}::${p.event_index}`;
          const baseMsg = `Point id: ${fullPointKey} not found or invalid`;
          details.push(detailed ? { point_id: fullPointKey, status: "not_found", message: baseMsg } : baseMsg);
          failed_count++;
        });
        return res.send(200, {
          success: true,
          message: "No valid stop-sign events found",
          processed_count: 0,
          skipped_count: 0,
          failed_count: pointObjs.length,
          details
        });
      }

      const stopData = dbResult[0].stop_data;
      logger.info(`[STOP] ${stopData.length} stop rows returned. Doing extrapolation...`);
      logger.access(`[STOP] ${stopData.length} stop rows returned. Doing extrapolation...`);

      const finalRows = [];

      for (const p of pointObjs) {
        const fullPointKey = p.tsp_name.startsWith("trips_")
          ? `${p.tsp_name}::${p.trip_id}::${p.event_index}`
          : `trips_${p.tsp_name}::${p.trip_id}::${p.event_index}`;

        const matchingRow = stopData.find(d => d.point_key === fullPointKey);

        if (!matchingRow) {
          const baseMsg = `Point id: ${fullPointKey} not found or invalid`;
          details.push(detailed ? { point_id: fullPointKey, status: "failed", message: baseMsg } : baseMsg);
          failed_count++;
          continue;
        }

        const extr = extrapolate(matchingRow.ss_latitude, matchingRow.ss_longitude, matchingRow.ss_bearing);
        logger.info(`[STOP] Extrapolated → ${extr.lat}, ${extr.lon} for ${fullPointKey}`);

        finalRows.push({
          ep_latitude: extr.lat,
          ep_longitude: extr.lon,
          ss_bearing: matchingRow.ss_bearing,
          ss_accuracy: matchingRow.ss_accuracy,
          src: "MANUAL"
        });

        const successMsg = `Created override for Point id: ${fullPointKey} and inserted successfully`;

        if (detailed) {
          details.push({
            point_id: fullPointKey,
            status: "success",
            message: successMsg,
            original: {
              latitude: matchingRow.ss_latitude,
              longitude: matchingRow.ss_longitude,
              bearing: matchingRow.ss_bearing,
              accuracy: matchingRow.ss_accuracy
            },
            extrapolated: {
              latitude: extr.lat,
              longitude: extr.lon
            },
            inserted: true
          });
        } else {
          details.push(successMsg);
        }

        processed_count++;
      }

      if (finalRows.length > 0) {
        await overrideDao.writeStopOverrides(finalRows);
        logger.info(`[STOP] Inserted ${finalRows.length} stop-sign overrides`);
        logger.access(`[STOP] Inserted ${finalRows.length} stop-sign overrides`);
      }

      skipped_count = pointObjs.length - processed_count - failed_count;

      res.send(200, {
        success: true,
        message: `Insert success — ${processed_count} new overrides created`,
        processed_count,
        skipped_count,
        failed_count,
        details
      });
    } catch (err) {
      logger.error(`[STOP] ERROR`, err);
      res.send(500, {
        success: false,
        message: err.message || "Internal server error"
      });
    }
  }
}

const overrideHandler = new OverrideHandler();

export default function registerOverrideRoutes(server) {
  server.post('/api/create-cluster-override', overrideHandler.createClusterOverride.bind(overrideHandler));
  server.post('/api/create-adas-override', overrideHandler.createAdasOverride.bind(overrideHandler));
  server.post('/api/create-stop-override', overrideHandler.createStopOverride.bind(overrideHandler));
  logger.access(`POST /api/create-cluster-override  - ready`);
  logger.access(`POST /api/create-adas-override     - ready`);
  logger.access(`POST /api/create-stop-override     - ready`);
}
