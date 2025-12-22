// overrideHandler.js
import overrideDao from '../data-access/overrideDataAccess.js';
import logger from '../logger.js';
import { snapToNearestRoadWithDirection, extrapolate } from '../snap_to_road.js';

const now = () => new Date().toISOString();

class OverrideHandler {
  _buildPointKey(point) {
    const { tsp_name, trip_id, event_index } = point;
    const prefix = tsp_name.startsWith("trips_") ? tsp_name : `trips_${tsp_name}`;
    return `${prefix}::${trip_id}::${event_index}`;
  }

  _sendValidationError(res, message, details = []) {
    return res.send(400, {
      success: false,
      error: message,
      details
    });
  }

  _buildSuccessResponse({ processed, skipped, failed, details, message }) {
    return {
      success: true,
      message,
      processed_count: processed.length,
      skipped_count: skipped.length,
      failed_count: failed.length,
      details
    };
  }

  async createClusterOverride(req, res) {
    const requestTime = now();
    const clusterInputs = req.body.cluster_ids || [];
    const isDetailed = !!req.body.detailed;

    logger.info(`[${requestTime}] [CLUSTER] Request received → ${clusterInputs.length} cluster(s)`);
    logger.access(`[${requestTime}] [CLUSTER] Request received → ${clusterInputs.length} cluster(s)`);

    try {
      if (!Array.isArray(clusterInputs) || clusterInputs.length === 0) {
        return this._sendValidationError(res, "cluster_ids must be a non-empty array");
      }

      const validationErrors = [];
      for (const cluster of clusterInputs) {
        if (typeof cluster !== 'object' || cluster === null || Array.isArray(cluster)) {
          validationErrors.push("Each item in cluster_ids must be an object");
          continue;
        }
        if (!cluster.cluster_id) {
          validationErrors.push("Missing cluster_id in one of the items");
          continue;
        }
        if (cluster.type !== undefined && cluster.type !== "OVERRIDE_VALUE") {
          validationErrors.push(`For cluster_id ${cluster.cluster_id}, type must be "OVERRIDE_VALUE" if provided`);
        }
      }

      if (validationErrors.length > 0) {
        return this._sendValidationError(res, "Invalid cluster_ids format", validationErrors);
      }

      logger.info(`[${requestTime}] [CLUSTER] Fetching batch data from DB...`);
      const [{ processed_count = 0, failed_count = 0, skipped_count = 0, failed_ids = [], skipped_ids = [], cluster_data = [] } = {}] =
        await overrideDao.getBatchClusterData(clusterInputs);

      if (processed_count === 0) {
        const details = clusterInputs.map(({ cluster_id }) => {
          if (failed_ids.includes(cluster_id)) return `Cluster ${cluster_id} not found or invalid`;
          if (skipped_ids.includes(cluster_id)) return `Cluster ${cluster_id} skipped (already has active override)`;
          return `Cluster ${cluster_id} not processed`;
        });

        res.send(200, {
          success: true,
          message: "No valid clusters to process",
          processed_count: 0,
          failed_count,
          skipped_count,
          details
        });
      }

      logger.info(`[${requestTime}] [CLUSTER] Snapping ${cluster_data.length} clusters to road...`);
      const snappedResults = await Promise.all(
        cluster_data.map(async (cluster) => {
          const snapStart = Date.now();
          try {
            const snappedPoint = await snapToNearestRoadWithDirection({
              cluster_id: cluster.cluster_id,
              lat: cluster.lat,
              lon: cluster.lon,
              bearing: cluster.bearing,
              country_code_iso3: cluster.country_code_iso3 || 'IND'
            });

            logger.info(`[${requestTime}] [CLUSTER] Snap success for ${cluster.cluster_id} (${Date.now() - snapStart}ms)`);

            return {
              ...cluster,
              ...snappedPoint,
              method: "snapped",
              status: "success",
              message: `Created override for cluster id: ${cluster.cluster_id} and inserted successfully`
            };
          } catch (error) {
            logger.error(`[${requestTime}] [CLUSTER] Snap failed for ${cluster.cluster_id}:`, error);
            return {
              ...cluster,
              method: "snap_failed",
              status: "failed",
              message: `Snap failed for cluster ${cluster.cluster_id}: ${error.message}`
            };
          }
        })
      );

      const successfulSnaps = snappedResults.filter(snapResult => snapResult.method === "snapped");
      const failedSnaps = snappedResults.filter(snapResult => snapResult.method === "snap_failed");

      if (successfulSnaps.length > 0) {
        const insertPayload = successfulSnaps.map(cluster => ({
          cluster_id: cluster.cluster_id,
          lat: cluster.lat,
          lon: cluster.lon,
          bearing: cluster.bearing,
          accuracy: cluster.accuracy,
          speed_limit_read_by_engine: cluster.speed_limit_read_by_engine,
          override_type: cluster.override_type || "OVERRIDE",
          override_value: cluster.override_value ?? null,
          expected_speed_sign_board_value: cluster.override_value ? null : cluster.speed_limit_read_by_engine,
          src: "MANUAL"
        }));

        await overrideDao.writeBatchClusterOverrides(insertPayload);
        logger.info(`[${requestTime}] [CLUSTER] Inserted ${successfulSnaps.length} overrides`);
        logger.access(`[${requestTime}] [CLUSTER] Inserted ${successfulSnaps.length} overrides`);
      }

      const details = clusterInputs.map(({ cluster_id }) => {
        const result = snappedResults.find(snapResult => snapResult.cluster_id === cluster_id);

        if (!result) {
          const msg = `Cluster ${cluster_id} not processed`;
          return isDetailed ? { cluster_id, status: "not_found", message: msg } : msg;
        }

        if (result.method === "snap_failed") {
          return isDetailed
            ? { cluster_id, status: "failed", message: result.message }
            : result.message;
        }

        if (isDetailed) {
          return {
            cluster_id,
            status: "success",
            message: result.message,
            original: {
              lat: result.original_lat || result.lat,
              lon: result.original_lon || result.lon,
              bearing: result.bearing,
              speed_limit: result.speed_limit_read_by_engine
            },
            snapped: {
              lat: result.lat,
              lon: result.lon,
              way_id: result.way_id,
              way_name: result.way_name
            },
            inserted: true
          };
        }

        return result.message;
      });

      res.send(200, {
        success: true,
        message: `Batch override completed — ${successfulSnaps.length} processed, ${failedSnaps.length} snap failed, ${skipped_count} skipped`,
        summary: {
          total_requested: clusterInputs.length,
          processed_count: successfulSnaps.length,
          failed_count: failedSnaps.length + failed_count,
          skipped_count,
          processed_ids: successfulSnaps.map(r => r.cluster_id),
          skipped_ids,
          failed_ids: [...failed_ids, ...failedSnaps.map(r => r.cluster_id)]
        },
        details
      });
    } catch (error) {
      logger.error(`[${requestTime}] [CLUSTER] Unexpected error:`, error);
      logger.access(`[${requestTime}] [CLUSTER] Unexpected error: ${error.message || 'Internal server error'}`);
      res.send(500, { success: false, message: error.message || "Internal server error" });
    }
  }

  async createAdasOverride(req, res) {
    const requestTime = now();
    const pointInputs = req.body.point_ids || [];
    const isDetailed = !!req.body.detailed;

    logger.info(`[${requestTime}] [ADAS] Request received → ${pointInputs.length} point(s)`);
    logger.access(`[${requestTime}] [ADAS] Request received → ${pointInputs.length} point(s)`);

    try {
      if (!Array.isArray(pointInputs) || pointInputs.length === 0) {
        return this._sendValidationError(res, "point_ids must be a non-empty array");
      }

      const typeErrors = pointInputs
        .filter(inputPoint => inputPoint.type !== undefined && inputPoint.type !== "OVERRIDE_VALUE")
        .map(inputPoint => {
          const id = inputPoint.point_id || inputPoint.id || '(unknown)';
          return `For point ${id}, type must be "OVERRIDE_VALUE" if provided`;
        });
 
      if (typeErrors.length > 0) {
        return this._sendValidationError(res, "Invalid type value in one or more items", typeErrors);
      }

      pointInputs.forEach(p => {
        if (p["OVERRIDE_VALUE"] !== undefined) {
          p.override_value = p["OVERRIDE_VALUE"];
        }
      });

      const dbResult = await overrideDao.getBatchViolationData(pointInputs);
      const resultRow = dbResult[0] || {};

      if (!resultRow || resultRow.processed_count === 0) {
        const details = pointInputs.map(point => {
          const pointKey = this._buildPointKey(point);
          const msg = `Point id: ${pointKey} not processed`;
          return isDetailed ? { point_id: pointKey, status: "not_found", message: msg } : msg;
        });

        res.send(200, {
          success: true,
          message: resultRow.skipped_count > 0
            ? `All points already have active overrides`
            : "No valid points to process",
          processed_count: 0,
          skipped_count: resultRow.skipped_count || 0,
          failed_count: resultRow.failed_count || 0,
          details
        });
      }

      const { violation_data } = resultRow;

      const snappedPoints = await Promise.all(
        violation_data.map(async (violation) => {
          try {
            const snapped = await snapToNearestRoadWithDirection({
              cluster_id: violation.point_key,
              lat: violation.lat,
              lon: violation.lon,
              bearing: violation.bearing,
              country_code_iso3: violation.sign
            });

            return {
              ...violation,
              ...snapped,
              method: "snapped",
              status: "success"
            };
          } catch (error) {
            logger.error(`[${requestTime}] [ADAS] Snap failed for ${violation.point_key}:`, error);
            return {
              ...violation,
              method: "snap_failed",
              status: "failed",
              message: `Snap failed: ${error.message}`
            };
          }
        })
      );

      const postSnapResults = await Promise.all(
        snappedPoints.map(async (point) => {
          if (point.method === "snap_failed") return point;

          const duplicateCheck = await overrideDao.checkAdasDuplicate(
            point.lat,
            point.lon,
            point.bearing,
            point.speed_limit_read_by_engine
          );

          if (duplicateCheck.duplicate) {
            return {
              ...point,
              method: "duplicate_skipped",
              status: "skipped",
              message: `Skipped — active override exists (ID: ${duplicateCheck.existing_id})`
            };
          }

          return {
            ...point,
            method: "ready_to_insert",
            status: "success"
          };
        })
      );

      const toInsert = postSnapResults.filter(r => r.method === "ready_to_insert");
      const duplicates = postSnapResults.filter(r => r.method === "duplicate_skipped");
      const snapFailed = postSnapResults.filter(r => r.method === "snap_failed");

      if (toInsert.length > 0) {
        const insertPayload = toInsert.map(pointtoinsert => ({
          violation_id: pointtoinsert.violation_id,
          lat: pointtoinsert.lat,
          lon: pointtoinsert.lon,
          bearing: pointtoinsert.bearing,
          accuracy: pointtoinsert.accuracy,
          speed_limit_read_by_engine: pointtoinsert.speed_limit_read_by_engine,
          override_type: pointtoinsert.override_type,
          override_speed_sign_board_value: pointtoinsert.override_value ?? null,
          expected_speed_sign_board_value: pointtoinsert.override_value ? null : pointtoinsert.expected_value ?? null
        }));

        await overrideDao.writeAdasOverrides(insertPayload);
        logger.info(`[${requestTime}] [ADAS] Inserted ${toInsert.length} new overrides`);
        logger.access(`[${requestTime}] [ADAS] Inserted ${toInsert.length} new overrides`);
      }

      const details = pointInputs.map(point => {
        const pointKey = this._buildPointKey(point);
        const match = postSnapResults.find(matchresult =>
          matchresult.trip_id === point.trip_id &&
          matchresult.event_index === point.event_index
        );

        if (!match) {
          const msg = `Point id: ${pointKey} not found`;
          return isDetailed ? { point_id: pointKey, status: "not_found", message: msg } : msg;
        }

        if (isDetailed) {
          return {
            point_id: pointKey,
            status: match.status,
            message: match.message || "Processed",
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

        return match.message || "Processed";
      });

      res.send(200, {
        success: toInsert.length > 0,
        message: toInsert.length > 0
          ? `Success — ${toInsert.length} new overrides created`
          : "All points already have active overrides",
        processed_count: toInsert.length,
        skipped_count: duplicates.length + (resultRow.skipped_count || 0),
        failed_count: snapFailed.length + (resultRow.failed_count || 0),
        details
      });
    } catch (error) {
      logger.error(`[${requestTime}] [ADAS] Unexpected error:`, error);
      logger.access(`[${requestTime}] [ADAS] Unexpected error: ${error.message || 'Internal server error'}`);
      res.send(500, { success: false, error: error.message || "Internal server error" });
    }
  }

  async createStopOverride(req, res) {
    const requestTime = now();
    const pointInputs = req.body.point_ids || [];
    const isDetailed = !!req.body.detailed;

    logger.info(`[${requestTime}] [STOP] Request → ${pointInputs.length} point(s)`);
    logger.access(`[${requestTime}] [STOP] Request → ${pointInputs.length} point(s)`);

    try {
      if (!Array.isArray(pointInputs) || pointInputs.length === 0) {
        return this._sendValidationError(res, "point_ids must be a non-empty array");
      }

      const dbResult = await overrideDao.getStopSignData(pointInputs);
      const resultRow = dbResult?.[0];

      if (!resultRow?.stop_data || resultRow.stop_data.length === 0) {
        const details = pointInputs.map(point => {
          const pointKey = this._buildPointKey(point);
          const msg = `Point id: ${pointKey} not found or invalid`;
          return isDetailed ? { point_id: pointKey, status: "not_found", message: msg } : msg;
        });

        res.send(200, {
          success: true,
          message: "No valid stop-sign events found",
          processed_count: 0,
          skipped_count: 0,
          failed_count: pointInputs.length,
          details
        });
      }

      const { stop_data } = resultRow;
      logger.info(`[${requestTime}] [STOP] Extrapolating ${stop_data.length} stop-sign points...`);

      const insertedRows = [];
      const responseDetails = [];

      for (const point of pointInputs) {
        const pointKey = this._buildPointKey(point);
        const stopRecord = stop_data.find(d => d.point_key === pointKey);

        if (!stopRecord) {
          const msg = `Point id: ${pointKey} not found or invalid`;
          responseDetails.push(isDetailed ? { point_id: pointKey, status: "failed", message: msg } : msg);
          continue;
        }

        const extrapolated = extrapolate(
          stopRecord.ss_latitude,
          stopRecord.ss_longitude,
          stopRecord.ss_bearing
        );

        logger.info(`[${requestTime}] [STOP] Extrapolated → (${extrapolated.lat}, ${extrapolated.lon}) for ${pointKey}`);

        insertedRows.push({
          ep_latitude: extrapolated.lat,
          ep_longitude: extrapolated.lon,
          ss_bearing: stopRecord.ss_bearing,
          ss_accuracy: stopRecord.ss_accuracy,
          src: "MANUAL"
        });

        const successMsg = `Created override for Point id: ${pointKey} and inserted successfully`;
        if (isDetailed) {
          responseDetails.push({
            point_id: pointKey,
            status: "success",
            message: successMsg,
            original: {
              latitude: stopRecord.ss_latitude,
              longitude: stopRecord.ss_longitude,
              bearing: stopRecord.ss_bearing,
              accuracy: stopRecord.ss_accuracy
            },
            extrapolated: {
              latitude: extrapolated.lat,
              longitude: extrapolated.lon
            },
            inserted: true
          });
        } else {
          responseDetails.push(successMsg);
        }
      }

      if (insertedRows.length > 0) {
        await overrideDao.writeStopOverrides(insertedRows);
        logger.info(`[${requestTime}] [STOP] Inserted ${insertedRows.length} stop-sign overrides`);
        logger.access(`[${requestTime}] [STOP] Inserted ${insertedRows.length} stop-sign overrides`);
      }

      res.send(200, {
        success: true,
        message: `Success — ${insertedRows.length} new overrides created`,
        processed_count: insertedRows.length,
        skipped_count: pointInputs.length - insertedRows.length,
        failed_count: 0,
        details: responseDetails
      });
    } catch (error) {
      logger.error(`[${requestTime}] [STOP] Unexpected error:`, error);
      logger.access(`[${requestTime}] [STOP] Unexpected error: ${error.message || 'Internal server error'}`);
      res.send(500, { success: false, message: error.message || "Internal server error" });
    }
  }
}

const overrideHandler = new OverrideHandler();

export default function registerOverrideRoutes(server) {
  server.post('/api/create-cluster-override', overrideHandler.createClusterOverride.bind(overrideHandler));
  server.post('/api/create-adas-override', overrideHandler.createAdasOverride.bind(overrideHandler));
  server.post('/api/create-stop-override', overrideHandler.createStopOverride.bind(overrideHandler));

  logger.access('POST /api/create-cluster-override - ready');
  logger.access('POST /api/create-adas-override - ready');
  logger.access('POST /api/create-stop-override - ready');
}