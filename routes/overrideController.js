import overrideService from '../services/overrideService.js';

async function createBatchOverride(req, res) { 
  try {
    const { cluster_ids } = req.body;

    if (!Array.isArray(cluster_ids) || cluster_ids.length === 0) {
      return res.send(400, {
        success: false,
        error: 'Bad Request',
        message: 'cluster_ids must be a non-empty array'
      });
    }

    const result = await overrideService.createBatchOverride({ cluster_ids });

    const {
      processed_count = 0,
      failed_count = 0,
      failed_ids = [],
      skipped_count = 0,
      skipped_ids = [],
      processed_ids = [],
      messages = []
    } = result;

    const hasIssues = failed_count > 0 || skipped_count > 0;
    const statusCode = hasIssues ? 207 : 200;

    const details = cluster_ids.map(id => {
      const specificMsg = messages.find(m => m.includes(String(id)));
      if (specificMsg) return specificMsg;

      if (failed_ids.includes(id)) return `Cluster ${id} not found or invalid`;
      if (skipped_ids.includes(id)) return `Cluster ${id} skipped (already active in overrides table)`;
      return `Cluster ${id} processed successfully`;
    });

    res.send(statusCode, {
      success: true,
      message: `Batch override completed – ${processed_count} processed, ${skipped_count} skipped, ${failed_count} failed`,
      summary: {
        total_requested: cluster_ids.length,
        processed_count,
        skipped_count,
        failed_count,
        processed_ids,
        skipped_ids,
        failed_ids
      },
      details,
      per_cluster_messages: messages.length > 0 ? messages : undefined
    });

  } catch (err) {
    console.error('createBatchOverride error:', err);
    res.send(500, {
      success: false,
      error: 'Internal Server Error',
      message: err.message || 'Unknown error occurred'
    });
  }
}

export default function registerRoutes(server) {
  server.post('/api/create-batch-override', createBatchOverride);
  console.log('POST /api/create-batch-override – snap-to-road override (detailed messages)');
}