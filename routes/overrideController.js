import db from '../database.js';

async function createBatchOverride(req, res) {
  try {
    const { cluster_ids } = req.body;

    if (!Array.isArray(cluster_ids) || cluster_ids.length === 0) {
      res.send(400, {
        error: 'Bad Request',
        message: 'cluster_ids must be a non-empty array'
      });
      return;
    }

    const results = await db.proc('create_batch_cluster_override_results', [cluster_ids]);

    if (results.length === 0) {
      res.send(404, {
        error: 'Not Found',
        message: 'No results returned from override operation'
      });
      return;
    }

    const {
      processed_count,
      failed_count,
      failed_ids,
      skipped_count,
      skipped_ids
    } = results[0];

    if (failed_count > 0 && processed_count === 0) {
      res.send(404, {
        error: 'Not Found',
        message: `Failed to create overrides for ${failed_count} cluster ID(s)`,
        details: { failed_ids, failed_count }
      });
      return;
    }

    const response = {
      success: true,
      message: `Batch override operation completed successfully for ${processed_count} cluster ID(s)`,
      cluster_ids,
      processed_ids: cluster_ids.filter(id => !failed_ids.includes(id) && !skipped_ids.includes(id)),
      processed_count,
      failed_count,
      failed_ids,
      skipped_count,
      skipped_ids
    };

    const statusCode = failed_count > 0 || skipped_count > 0 ? 207 : 200;
    res.send(statusCode, response);
  } catch (error) {
    console.error('Error in createBatchOverride:', error);
    res.send(500, {
      error: 'Internal Server Error',
      message: 'Failed to create overrides',
      details: error.message
    });
  }
}

export default function registerRoutes(server) {
  server.post('/api/create-batch-override', createBatchOverride);
  console.log('Override routes registered:');
  console.log('  POST /api/create-batch-override - Create overrides');
}