import overrideService from '../services/overrideService.js';

async function createBatchOverride(req, res) {
  try {
    const { cluster_ids } = req.body;
    if (!Array.isArray(cluster_ids) || cluster_ids.length === 0) {
      return res.send(400, {
        error: 'Bad Request',
        message: 'cluster_ids must be a non-empty array'
      });
    }

    const result = await overrideService.createBatchOverride({ cluster_ids });

    const {
      processed_count,
      failed_count,
      failed_ids,
      skipped_count,
      skipped_ids,
      processed_ids
    } = result;

    const status = (failed_count > 0 || skipped_count > 0) ? 207 : 200;

    res.send(status, {
      success: true,
      message: `Batch override completed – ${processed_count} processed`,
      cluster_ids,
      processed_ids,
      processed_count,
      failed_count,
      failed_ids,
      skipped_count,
      skipped_ids
    });
  } catch (err) {
    console.error('createBatchOverride error:', err);
    res.send(500, {
      error: 'Internal Server Error',
      message: err.message
    });
  }
}

export default function registerRoutes(server) {
  server.post('/api/create-batch-override', createBatchOverride);
  console.log('POST /api/create-batch-override – snap-to-road override');
}